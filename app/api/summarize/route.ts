import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractVideoId } from "@/lib/youtube";
import { spawn } from "child_process";
import { YoutubeTranscript } from "youtube-transcript";
import { chunkTranscript, type TranscriptChunk } from "@/lib/chunking";
import {
  callWithFallback,
  getAvailableModels,
  LlmRateLimitError,
  type ModelId,
} from "@/lib/llmChain";
import { extractTopics, type ExtractedTopic } from "@/lib/topicExtraction";
import { logApiUsage } from "@/lib/usageLogger";
import { authenticateRequest } from "@/lib/apiAuth";
import { ingestTranscriptChunks } from "@/lib/ingestTranscriptChunks";
import { checkRateLimit } from "@/lib/rateLimit";

/**
 * CORS helper â€” allows requests from Chrome extensions and localhost dev.
 */
function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  // Allow any chrome-extension:// origin (our own extension) + localhost
  const allowed =
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("http://localhost");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
    "Access-Control-Allow-Credentials": "true",
  };
}

/**
 * OPTIONS handler â€” required for CORS preflight from the extension.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}

/**
 * Progress event types for streaming responses
 */
type ProgressEvent =
  | { type: "progress"; stage: Stage; message: string; detail?: string }
  | { type: "stream_chunk"; chunk: string }
  | { type: "complete"; summary: SummaryResult; status: "completed" }
  | { type: "error"; error: string; details?: string };

/**
 * Summary stages for progress tracking
 */
type Stage = "fetching_transcript" | "analyzing_topics" | "generating_summary" | "building_timeline";

/**
 * Summary result structure
 */
interface SummaryResult {
  id: string;
  videoId: string;
  title: string;
  content: string;
  hasTimestamps: boolean;
  topics: Array<{
    id: string;
    title: string;
    startMs: number;
    endMs: number;
    order: number;
  }>;
  transcriptSegments: Array<{
    id: string;
    text: string;
    offset: number;
    duration: number;
    order: number;
  }>;
  modelUsed: ModelId;
  source: "cache" | "generated";
}

/**
 * GET handler - Returns available models for the user
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.success) {
    return new NextResponse(auth.response.body, {
      status: auth.response.status,
      headers: { ...Object.fromEntries(auth.response.headers), ...corsHeaders(req) },
    });
  }

  try {
    const models = await getAvailableModels(auth.userId);
    return NextResponse.json({ models }, { headers: corsHeaders(req) });
  } catch {
    return NextResponse.json(
      { error: "Failed to get available models" },
      { status: 500, headers: corsHeaders(req) }
    );
  }
}

/**
 * Supported output languages for summaries
 * Matches the extension's lang-select dropdown exactly
 */
type OutputLanguage =
  | "en" | "hi" | "es" | "fr" | "de"
  | "pt" | "zh" | "ja" | "ko" | "ar" | "ru" | "it";

const LANGUAGE_NAMES: Record<OutputLanguage, string> = {
  en: "English",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  zh: "Chinese (Simplified)",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  ru: "Russian",
  it: "Italian",
};

/**
 * POST handler - Generate a video summary
 * Accepts: { url: string, detailLevel?: number, language?: OutputLanguage }
 * Returns: Streaming progress events
 */
export async function POST(req: NextRequest) {
  // Authenticate request first
  const auth = await authenticateRequest(req);
  if (!auth.success) {
    return new NextResponse(auth.response.body, {
      status: auth.response.status,
      headers: { ...Object.fromEntries(auth.response.headers), ...corsHeaders(req) },
    });
  }

  // Rate limit by userId (authenticated users get their own limit)
  const rateLimit = checkRateLimit(auth.userId, 10, 60 * 1000);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        retryAfterMs: rateLimit.retryAfterMs,
        message: "Too many requests. Please wait before trying again."
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimit.retryAfterMs || 60000) / 1000)),
          'X-RateLimit-Remaining': '0',
          ...corsHeaders(req),
        }
      }
    );
  }

  const userId = auth.userId;
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const writeProgress = async (event: ProgressEvent) => {
    await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
  };

  // Process the request asynchronously
  (async () => {
    try {
      const body = await req.json();
      const { url, detailLevel = 3, language = "en" } = body as {
        url: string;
        detailLevel?: number;
        language?: OutputLanguage;
      };

      if (!url) {
        await writeProgress({
          type: "error",
          error: "URL is required",
        });
        await writer.close();
        return;
      }

      // Extract video ID
      let videoId: string;
      try {
        videoId = extractVideoId(url);
      } catch {
        await writeProgress({
          type: "error",
          error: "Invalid YouTube URL",
          details: "Could not extract video ID from the provided URL",
        });
        await writer.close();
        return;
      }

      // â”€â”€ Language-aware cache lookup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Query for an existing summary matching this exact video + user + language.
      // Each combination is stored separately, so switching languages is a cache miss.
      const langName = LANGUAGE_NAMES[language as OutputLanguage] ?? language;
      console.log(`[Cache] Looking up videoId=${videoId} userId=${userId} language=${language}`);

      const existingSummary = await prisma.summary.findFirst({
        where: { videoId, userId, language },
        include: {
          topics:             { orderBy: { order: "asc" } },
          transcriptSegments: { orderBy: { order: "asc" } },
        },
      });

      if (existingSummary) {
        console.log(`[Cache HIT] videoId=${videoId} language=${language} â€“ returning cached summary`);
        await writeProgress({
          type: "complete",
          summary: {
            id: existingSummary.id,
            videoId: existingSummary.videoId,
            title: existingSummary.title,
            content: existingSummary.content,
            hasTimestamps: existingSummary.hasTimestamps,
            topics: existingSummary.topics.map((t) => ({
              id: t.id,
              title: t.title,
              startMs: t.startMs,
              endMs: t.endMs,
              order: t.order,
            })),
            transcriptSegments: existingSummary.transcriptSegments.map((s) => ({
              id: s.id,
              text: s.text,
              offset: s.offset,
              duration: s.duration,
              order: s.order,
            })),
            modelUsed: "cached",
            source: "cache",
            language,
          },
          status: "completed",
        });
        await writer.close();
        return;
      }

      console.log(`[Cache MISS] videoId=${videoId} language=${language} â€“ generating fresh summary`);

      // Stage 1: Fetch Transcript
      await writeProgress({
        type: "progress",
        stage: "fetching_transcript",
        message: "Fetching video transcript...",
      });

      let transcriptResult: Array<{text:string;offset:number;duration:number}> | string | undefined;
      let hasTimestamps = true;

      // â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
      // â•‘           3-TIER TRANSCRIPT FALLBACK CHAIN              â•‘
      // â•‘ Tier 1 â”‚ youtube-transcript library (fast, primary)     â•‘
      // â•‘ Tier 2 â”‚ ytdl-core caption API (no system tools)        â•‘
      // â•‘ Tier 3 â”‚ yt-dlp + Groq audio (for no-caption videos)    â•‘
      // â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

      // â”€â”€ Tier 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      try {
        try {
          transcriptResult = await YoutubeTranscript.fetchTranscript(videoId);
          console.log("[Transcript] âœ… Tier 1 (youtube-transcript) succeeded");
        } catch {
          transcriptResult = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
          console.log("[Transcript] âœ… Tier 1 lang=en retry succeeded");
        }
      } catch (t1Err) {
        console.warn("[Transcript] âš ï¸ Tier 1 failed:", t1Err instanceof Error ? t1Err.message : t1Err);
      }

      // -- Tier 2: yt-dlp metadata -> subtitle URL -> direct HTTP fetch ----------
      // yt-dlp is actively maintained and updated to bypass YouTube bot detection.
      // It extracts the direct subtitle URL so we can fetch captions without audio.
      // We cache the metadata so Tier 3 can reuse it without a second yt-dlp call.
      let ytDlpVideoInfo = null;
      if (!transcriptResult) {
        try {
          console.log("[Transcript] Trying Tier 2 (yt-dlp subtitle extraction)...");
          await writeProgress({ type: "progress", stage: "fetching_transcript", message: "Fetching subtitles via yt-dlp..." });

          const infoStr = await new Promise((resolve, reject) => {
            const p = spawn("yt-dlp", ["--dump-json", url]);
            let out = "";
            p.stdout.on("data", (d) => (out += d.toString()));
            p.on("close", (code) => { if ((code === 0 || code === 1) && out.trim()) { resolve(out); } else { reject(new Error("yt-dlp failed, code: " + code)); } });
            p.on("error", (err) => reject(new Error(`yt-dlp not found: ${err.message}`)));
          });

          const info = JSON.parse(infoStr);
          ytDlpVideoInfo = info;

          if (info.is_live) throw new Error("Cannot summarize active livestreams.");

          const manualSubs = info.subtitles ?? {};
          const autoCaps   = info.automatic_captions ?? {};
          const allManualLangs = Object.keys(manualSubs);
          const allAutoLangs   = Object.keys(autoCaps);
          // Try: en (manual) -> en-US (manual) -> any-en-prefix (manual) -> en (auto) -> en-US (auto) -> any-en-prefix (auto) -> first available
          const subFormats =
            manualSubs["en"]    ?? manualSubs["en-US"]    ?? (allManualLangs.find(l => l.startsWith("en")) ? manualSubs[allManualLangs.find(l => l.startsWith("en"))] : null) ??
            autoCaps["en"]      ?? autoCaps["en-US"]      ?? (allAutoLangs.find(l => l.startsWith("en")) ? autoCaps[allAutoLangs.find(l => l.startsWith("en"))] : null) ??
            (allManualLangs.length ? manualSubs[allManualLangs[0]] : null) ??
            (allAutoLangs.length   ? autoCaps[allAutoLangs[0]]   : null);
          if (!subFormats || subFormats.length === 0) throw new Error("No subtitle tracks found");

          const fmt = subFormats.find((s) => s.ext === "json3") ??
                      subFormats.find((s) => s.ext === "vtt")   ??
                      subFormats[0];

          console.log(`[Transcript] Fetching subtitle ext=${fmt.ext}`);
          const subRes = await fetch(fmt.url);
          if (!subRes.ok) throw new Error(`Subtitle fetch HTTP ${subRes.status}`);

          let segments;
          if (fmt.ext === "json3") {
            const data = await subRes.json();
            segments = (data.events ?? [])
              .filter((e) => Array.isArray(e.segs) && e.segs.length > 0)
              .map((e) => ({
                text:     (e.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\n/g, " ").trim(),
                offset:   e.tStartMs   ?? 0,
                duration: e.dDurationMs ?? 0,
              }))
              .filter((s) => s.text.length > 0);
          } else {
            const vtt = await subRes.text();
            segments = parseVttToSegments(vtt);
          }

          if (!segments.length) throw new Error("Subtitle data empty after parsing");
          transcriptResult = segments;
          hasTimestamps    = true;
          console.log(`[Transcript] Tier 2 succeeded - ${segments.length} segments`);
        } catch (t2Err) {
          console.warn("[Transcript] Tier 2 failed:", t2Err instanceof Error ? t2Err.message : String(t2Err));
        }
      }

      // â”€â”€ Tier 3: yt-dlp + Groq Whisper (for videos with no captions) â”€â”€â”€â”€
      if (!transcriptResult) {
        console.log("[Transcript] Trying Tier 3 (yt-dlp + Groq audio)...");
        await writeProgress({ type: "progress", stage: "fetching_transcript", message: "No captions found â€” transcribing audio directly..." });

        try {
          // Reuse cached metadata from Tier 2 if available (avoids double yt-dlp call)
          let videoInfo = ytDlpVideoInfo;
          if (!videoInfo) {
            const infoStr2 = await new Promise((resolve, reject) => {
              const p = spawn("yt-dlp", ["--dump-json", url]);
              let out = "";
              p.stdout.on("data", (d) => (out += d.toString()));
              p.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`yt-dlp metadata failed (code ${code})`)));
              p.on("error", (err) => reject(new Error(`yt-dlp not found: ${err.message}`)));
            });
            videoInfo = JSON.parse(infoStr2);
          }
          if (videoInfo.is_live) throw new Error("Cannot summarize active livestreams.");
          const durationSeconds = videoInfo.duration || 0;
          let fullTranscript = "";

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const ffmpegPath: string = require("ffmpeg-static") as string;
          const os   = require("os");
          const fs   = require("fs");
          const path = require("path");

          await writeProgress({ type: "progress", stage: "fetching_transcript", message: "Downloading audio track..." });
          const fullAudioFile = path.join(os.tmpdir(), `full-audio-${Date.now()}.m4a`);
          await new Promise<void>((resolve, reject) => {
            const p = spawn("yt-dlp", ["--ffmpeg-location", ffmpegPath, "-f", "bestaudio[ext=m4a]/bestaudio", "--force-overwrites", "-o", fullAudioFile, url], { stdio: "ignore" });
            p.on("close", (c) => c === 0 ? resolve() : reject(new Error(`yt-dlp failed (code ${c})`)));
            p.on("error", reject);
          });

          const fileSizeMB = (fs.statSync(fullAudioFile).size as number) / (1024 * 1024);
          const transcribeChunk = async (filePath: string) => {
            const buf = fs.readFileSync(filePath) as Buffer;
            const file = new File([new Uint8Array(buf)], "audio.m4a", { type: "audio/mp4" });
            const fd = new FormData();
            fd.append("file", file); fd.append("model", "whisper-large-v3");
            const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: fd });
            if (!res.ok) throw new Error(`Groq error: ${await res.text()}`);
            return ((await res.json()) as { text: string }).text;
          };

          if (fileSizeMB < 24) {
            fullTranscript = await transcribeChunk(fullAudioFile);
          } else {
            const CHUNK = 1200;
            const n = Math.ceil(durationSeconds / CHUNK) || 1;
            for (let i = 0; i < n; i++) {
              const chunkFile = path.join(os.tmpdir(), `chunk-${Date.now()}-${i}.m4a`);
              await writeProgress({ type: "progress", stage: "fetching_transcript", message: `Transcribing audio chunk ${i + 1}/${n}...` });
              await new Promise<void>((resolve, reject) => {
                const ff = spawn(ffmpegPath, ["-i", fullAudioFile, "-ss", (i * CHUNK).toString(), "-t", CHUNK.toString(), "-c", "copy", chunkFile], { stdio: "ignore" });
                ff.on("close", (c) => c === 0 ? resolve() : reject(new Error(`ffmpeg failed (code ${c})`)));
                ff.on("error", reject);
              });
              fullTranscript += " " + await transcribeChunk(chunkFile);
              try { fs.unlinkSync(chunkFile); } catch { /* ignore */ }
            }
          }
          try { fs.unlinkSync(fullAudioFile); } catch { /* ignore */ }
          transcriptResult = fullTranscript.trim();
          hasTimestamps    = false;
          console.log("[Transcript] âœ… Tier 3 (yt-dlp + Groq) succeeded");

        } catch (t3Err) {
          const t3msg = t3Err instanceof Error ? t3Err.message : String(t3Err);
          console.error("[Transcript] âŒ All tiers failed. Tier 3:", t3msg);
          const isToolMissing = t3msg.includes("ENOENT") || t3msg.includes("yt-dlp");
          await writeProgress({
            type: "error",
            error: isToolMissing
              ? "Couldn't fetch this video's transcript â€” please try again in a moment."
              : "No captions or audio track could be found for this video.",
            details: t3msg,
          });
          await writer.close();
          return;
        }
      }

      // Map over the array objects to match chunkTranscript expectations
      const transcriptContent = transcriptResult;

      // â”€â”€ Guard: some videos return null/empty content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (
        transcriptContent == null ||
        (Array.isArray(transcriptContent) && transcriptContent.length === 0) ||
        (typeof transcriptContent === "string" && transcriptContent.trim().length === 0)
      ) {
        await writeProgress({
          type: "error",
          error: "No transcript available for this video",
          details: "The video may be private, age-restricted, or have no captions/subtitles.",
        });
        await writer.close();
        return;
      }

      // Convert transcript content to string for storage and LLM processing
      const transcriptText = Array.isArray(transcriptContent)
        ? transcriptContent.map((s) => s.text).join(" ")
        : transcriptContent;

      // Calculate video duration from transcript segments
      let videoDurationMs = 0;
      if (Array.isArray(transcriptContent) && transcriptContent.length > 0) {
        const lastSegment = transcriptContent[transcriptContent.length - 1];
        videoDurationMs = lastSegment.offset + lastSegment.duration;
      }

      // Stage 2: Analyzing Topics (Smart Chunking)
      await writeProgress({
        type: "progress",
        stage: "analyzing_topics",
        message: "Analyzing content structure...",
      });

      const chunks = chunkTranscript(transcriptContent as any, hasTimestamps);

      // Stage 3: Generate Summary
      await writeProgress({
        type: "progress",
        stage: "generating_summary",
        message: "Generating summary...",
        detail: `Processing ${chunks.length} content sections`,
      });

      const { summary, modelUsed, tokensUsed } = await generateChapterBasedSummary(
        chunks,
        detailLevel,
        language as OutputLanguage,
        videoId,
        userId,
        hasTimestamps,
        async (textChunk) => {
          await writeProgress({ type: "stream_chunk", chunk: textChunk });
        }
      );

      // Log LLM usage
      await logApiUsage(userId, modelUsed, "summary", 0, tokensUsed || 0);

      // Extract title from summary or generate one
      const title = extractTitleFromSummary(summary) || `Video Summary - ${videoId}`;

      // Stage 4: Build Timeline (Topic Extraction)
      let topics: ExtractedTopic[] = [];
      if (hasTimestamps && videoDurationMs > 0) {
        await writeProgress({
          type: "progress",
          stage: "building_timeline",
          message: "Extracting topics for timeline...",
        });

        try {
          const topicResult = await extractTopics(
            transcriptText,
            summary,
            videoDurationMs,
            { userId }
          );
          topics = topicResult.topics;

          // Log LLM usage for topic extraction
          await logApiUsage(
            userId,
            topicResult.modelUsed,
            "topic_extraction",
            0,
            topicResult.tokensUsed || 0
          );
        } catch (topicError) {
          // Topic extraction is optional - continue without topics
          console.warn("Topic extraction failed:", topicError);
        }
      }

      // Save transcript segments if available
      const transcriptSegmentsData = Array.isArray(transcriptContent)
        ? transcriptContent.map((segment, index) => ({
            text: segment.text,
            offset: segment.offset,
            duration: segment.duration,
            order: index,
          }))
        : [];

      // Save to database â€” upsert keyed on (videoId, userId, language) so each
      // language gets its own row and switching languages never overwrites another.
      console.log(`[Cache MISS] Saving summary â€” videoId=${videoId} language=${language}`);
      const savedSummary = await prisma.summary.upsert({
        where: {
          videoId_userId_language: { videoId, userId, language },
        },
        update: {
          title,
          content: summary,
          transcript: transcriptText,
          hasTimestamps,
          language,
          // Replace topics: delete old ones and create new
          topics: {
            deleteMany: {},
            create: topics.map((topic) => ({
              title: topic.title,
              startMs: topic.startMs,
              endMs: topic.endMs,
              order: topic.order,
            })),
          },
          // Replace transcript segments
          transcriptSegments: {
            deleteMany: {},
            create: transcriptSegmentsData,
          },
        },
        create: {
          videoId,
          userId,
          title,
          language,
          content: summary,
          transcript: transcriptText,
          hasTimestamps,
          topics: {
            create: topics.map((topic) => ({
              title: topic.title,
              startMs: topic.startMs,
              endMs: topic.endMs,
              order: topic.order,
            })),
          },
          transcriptSegments: {
            create: transcriptSegmentsData,
          },
        },
        include: {
          topics: { orderBy: { order: "asc" } },
          transcriptSegments: { orderBy: { order: "asc" } },
        },
      });

      // Return complete result
      await writeProgress({
        type: "complete",
        summary: {
          id: savedSummary.id,
          videoId: savedSummary.videoId,
          title: savedSummary.title,
          content: savedSummary.content,
          hasTimestamps: savedSummary.hasTimestamps,
          topics: savedSummary.topics.map((t) => ({
            id: t.id,
            title: t.title,
            startMs: t.startMs,
            endMs: t.endMs,
            order: t.order,
          })),
          transcriptSegments: savedSummary.transcriptSegments.map((s) => ({
            id: s.id,
            text: s.text,
            offset: s.offset,
            duration: s.duration,
            order: s.order,
          })),
          modelUsed,
          source: "generated",
        },
        status: "completed",
      });

      // â”€â”€ RAG Ingestion (Phase 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Fire-and-forget: run AFTER the SSE "complete" event is written so the
      // user already has their summary. Any failure here is logged only â€”
      // it must NEVER surface to the user or break the summarize flow.
      ingestTranscriptChunks({
        summaryId:  savedSummary.id,
        videoId,
        userId,
        transcript: transcriptText,
      }).catch((err) =>
        console.error("[RAG] Background ingestion failed â€” will retry next summarise:", err)
      );
    } catch (error) {
      console.error("Summarize error:", error);

      // Provide user-friendly error messages based on error type
      let errorMessage = "Failed to generate summary";
      let errorDetails: string | undefined;

      if (error instanceof LlmRateLimitError) {
        errorMessage = error.message;
        errorDetails = error.retryAfterMs
          ? `Suggested retry after ${Math.ceil(error.retryAfterMs / 1000)}s`
          : "The configured AI provider rejected the request because of rate limits.";
      } else if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack;
      }

      await writeProgress({
        type: "error",
        error: errorMessage,
        details: errorDetails,
      });
    } finally {
      await writer.close().catch(() => {
        // Ignore close errors
      });
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(req),
    },
  });
}

/**
 * Detail level configuration for chapter-based summaries
 */
interface DetailConfig {
  description: string;
  bulletPointsPerChapter: number;
  showTransitions: boolean;
  topChaptersOnly: boolean;
  topChapterCount?: number;
}

const DETAIL_CONFIGS: Record<number, DetailConfig> = {
  1: {
    description: "very brief",
    bulletPointsPerChapter: 1,
    showTransitions: false,
    topChaptersOnly: true,
    topChapterCount: 3,
  },
  2: {
    description: "concise",
    bulletPointsPerChapter: 2,
    showTransitions: false,
    topChaptersOnly: true,
    topChapterCount: 3,
  },
  3: {
    description: "balanced",
    bulletPointsPerChapter: 3,
    showTransitions: false,
    topChaptersOnly: false,
  },
  4: {
    description: "detailed",
    bulletPointsPerChapter: 4,
    showTransitions: true,
    topChaptersOnly: false,
  },
  5: {
    description: "comprehensive",
    bulletPointsPerChapter: 5,
    showTransitions: true,
    topChaptersOnly: false,
  },
};

/**
 * Generate chapter-based summary from transcript chunks
 */
async function generateChapterBasedSummary(
  chunks: TranscriptChunk[],
  detailLevel: number,
  language: OutputLanguage,
  videoId: string,
  userId: string,
  hasTimestamps: boolean,
  onChunk?: (text: string) => void
): Promise<{ summary: string; modelUsed: ModelId; tokensUsed?: number }> {
  const config = DETAIL_CONFIGS[detailLevel] || DETAIL_CONFIGS[3];
  const languageName = LANGUAGE_NAMES[language] || "English";

  // Combine all chunks into a single transcript
  const fullTranscript = chunks
    .map((chunk) => {
      if (chunk.startMs !== undefined && chunk.endMs !== undefined) {
        return `[${formatTime(chunk.startMs)} - ${formatTime(chunk.endMs)}]\n${chunk.text}`;
      }
      return chunk.text;
    })
    .join("\n\n");

  // Build the chapter-based summary prompt
  const systemPrompt = `You are an expert video content analyst creating comprehensive, chapter-based summaries. Your summaries should allow someone to fully understand the video's content, context, and value without watching it.

Key principles:
- Structure the summary around chapters/topics in the video
- Create flowing narrative with highlighted key points
- Show how chapters connect and build upon each other
- Be factual and neutral, never critical
- Use clear, engaging language`;

  const userPrompt = buildChapterBasedPrompt(
    fullTranscript,
    videoId,
    config,
    languageName,
    hasTimestamps
  );

  const result = await callWithFallback(userPrompt, {
    systemPrompt,
    maxTokens: 6144,
    temperature: 0.7,
    userId,
    onChunk,
  });

  return {
    summary: result.response,
    modelUsed: result.modelUsed,
    tokensUsed: result.tokensUsed,
  };
}

/**
 * Build the chapter-based summary prompt
 */
function buildChapterBasedPrompt(
  transcript: string,
  videoId: string,
  config: DetailConfig,
  languageName: string,
  hasTimestamps: boolean
): string {
  const bulletPointInstruction = config.bulletPointsPerChapter <= 2
    ? `- Include only ${config.bulletPointsPerChapter} key bullet point(s) per chapter`
    : `- Include ${config.bulletPointsPerChapter} detailed bullet points per chapter`;

  const transitionInstruction = config.showTransitions
    ? `- Add a transition note (â†’ *Connection to next chapter: [explanation]*) showing how each chapter leads to the next`
    : "";

  const chapterScopeInstruction = config.topChaptersOnly
    ? `- Focus on the top ${config.topChapterCount} most important chapters in detail
- Briefly mention other chapters in a single line each`
    : `- Cover all identified chapters with appropriate depth`;

  const timeLink = hasTimestamps
    ? ` [(0:00)](https://youtube.com/watch?v=${videoId}&t=0s)`
    : ``;
  const timeRule = hasTimestamps
    ? `\n- CRITICAL: Each chapter heading and each recommended chapter MUST include a real clickable timestamp link in this EXACT format: [(M:SS)](https://youtube.com/watch?v=${videoId}&t=Xs) where you replace M:SS with the actual chapter start time and X with the actual total seconds. For example: [(2:15)](https://youtube.com/watch?v=${videoId}&t=135s). NEVER write the word "Timestamp" or "XXs" â€” those are WRONG. Always use real numbers from the transcript timestamps.`
    : ``;

  return `Analyze this video transcript and create a ${config.description} chapter-based summary.

**IMPORTANT: Write the entire summary in ${languageName}.**

**Transcript:**
${transcript.slice(0, 12000)}${transcript.length > 12000 ? "\n\n[Transcript truncated...]" : ""}

**Instructions:**
1. First, identify the main chapters/topics discussed in the video based on natural topic transitions
2. Then create a structured summary following the format below

**Output Format:**

**Title**: [Descriptive title for the video content]

**Overview**: [2-3 sentences providing context - what this video covers and who it's for]

**Recommended Chapters to Watch**:
- [Chapter Name] - [Reason why this is worth watching in full]${timeLink}
- [Another Chapter] - [Reason]${timeLink}

---

## Chapter 1: [Chapter Title]${timeLink}
[2-3 sentence flowing summary of this chapter's content]
${bulletPointInstruction}
${transitionInstruction}

## Chapter 2: [Chapter Title]${timeLink}
[Continue with same structure...]

---

**Conclusion**: [Key takeaways and practical applications from the video]

**Formatting Rules:**
${chapterScopeInstruction}${timeRule}
- Use **bold** for key terms and concepts
- Be factual and neutral - summarize, don't critique`;
}

/**
 * Extract title from the generated summary
 */
function extractTitleFromSummary(summary: string): string | null {
  // Look for **Title**: or # Title patterns
  const titlePatterns = [
    /\*\*Title\*\*:\s*(.+)/i,
    /^#\s+(.+)/m,
    /^Title:\s*(.+)/mi,
  ];

  for (const pattern of titlePatterns) {
    const match = summary.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Format milliseconds to human-readable time string
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Parse a WebVTT subtitle file into transcript segments (offsets in milliseconds). */
function parseVttToSegments(vtt: string): Array<{ text: string; offset: number; duration: number }> {
  const segments: Array<{ text: string; offset: number; duration: number }> = [];
  const toMs = (t: string): number => {
    // Handle both "HH:MM:SS.mmm" and "MM:SS.mmm"
    const clean = t.replace(",", ".");
    const parts = clean.split(":");
    let h = 0, m = 0, s = 0;
    if (parts.length === 3) { h = +parts[0]; m = +parts[1]; s = +parts[2]; }
    else if (parts.length === 2) { m = +parts[0]; s = +parts[1]; }
    return Math.round((h * 3600 + m * 60 + s) * 1000);
  };

  const lines = vtt.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(/(\d{2}:[\d:]+[\d.,]+)\s*-->\s*(\d{2}:[\d:]+[\d.,]+)/);
    if (match) {
      const startMs = toMs(match[1]);
      const endMs   = toMs(match[2]);
      i++;
      const textParts: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        // Strip VTT inline tags like <c>, <b>, timestamps, etc.
        const cleaned = lines[i].replace(/<[^>]+>/g, "").trim();
        if (cleaned) textParts.push(cleaned);
        i++;
      }
      const text = textParts.join(" ").trim();
      if (text) {
        segments.push({ text, offset: startMs, duration: Math.max(0, endMs - startMs) });
      }
    } else {
      i++;
    }
  }
  return segments;
}
