/**
 * app/api/chat/route.ts
 *
 * RAG Chat API — Phase 3
 *
 * Flow:
 *   1. Authenticate user
 *   2. Embed the user's question using gemini-embedding-001
 *   3. Cosine-similarity search via pgvector to fetch the top-K transcript chunks
 *   4. Inject chunks as context into a system prompt
 *   5. Stream the LLM answer back via SSE (same pattern as /api/summarize)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateRequest } from "@/lib/apiAuth";
import { callWithFallback } from "@/lib/llmChain";

const EMBED_MODEL = "gemini-embedding-001"; // 3072-dim, confirmed working
const TOP_K       = 5;                      // default chunks to retrieve
const TOP_K_TIME  = 10;                     // expanded retrieval for temporal queries

// Casual messages that should NOT trigger video RAG lookup
const GREETING_RE = /^(hey+|hi+|hello|sup|hiya|howdy|yo+|heya|good (morning|afternoon|evening)|thanks?|thank you|thx|ty|ok(ay)?|sure|cool|nice|great|awesome|lol|haha|👋)[!.? ]*$/i;

// Temporal references like "after 5 mins", "at 10:30", "5 minutes in"
const TIME_RE = /\b(\d+)\s*(min(ute)?s?|hr?s?|hour|sec(ond)?s?)\s*(in|into|after|at|mark|later)|\bat\s+\d+:\d+|\bfirst\s+\d+\s*min|\blast\s+\d+\s*min/i;


// ── Embed the user's query ────────────────────────────────────────────────────
async function embedQuery(text: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 9000) }] },
        taskType: "RETRIEVAL_QUERY", // tells Gemini this is a search query (not a document)
      }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini embedQuery ${resp.status}: ${body}`);
  }

  const json = (await resp.json()) as { embedding: { values: number[] } };
  return json.embedding.values;
}

// ── CORS helper (mirrors the summarize route pattern) ─────────────────────────
function corsHeaders(req: NextRequest) {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 1. Auth
  const auth = await authenticateRequest(req);
  if (!auth.success) {
    return new NextResponse(auth.response.body, {
      status: auth.response.status,
      headers: { ...Object.fromEntries(auth.response.headers), ...corsHeaders(req) },
    });
  }

  const body = await req.json() as {
    message?: string;
    videoId?: string;
    history?: Array<{ role: string; content: string }>;
  };
  const message = body.message?.trim();
  const videoId = body.videoId?.trim();
  // Conversation history — last 6 entries (3 Q&A pairs) for follow-up support
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter(h => h && typeof h.role === 'string' && typeof h.content === 'string')
    .slice(-6);

  if (!message || !videoId) {
    return NextResponse.json(
      { error: "Both 'message' and 'videoId' are required." },
      { status: 400, headers: corsHeaders(req) }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server." },
      { status: 500, headers: corsHeaders(req) }
    );
  }

  // ── Set up SSE stream ─────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();

  const write = (obj: object) =>
    writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

  // Run everything in the background so we can return the stream immediately
  (async () => {
    try {
      // ── Greeting / small-talk short-circuit ──────────────────────────────
      // Don't inject video context for casual openers like "hey", "thanks", etc.
      if (GREETING_RE.test(message.trim())) {
        const reply = /thanks?|thank you|thx|ty/i.test(message)
          ? "Happy to help! Got any other questions about the video?"
          : /ok(ay)?|sure/i.test(message)
          ? "Sure! Feel free to ask anything about the video."
          : /cool|nice|great|awesome/i.test(message)
          ? "Glad that helped! Anything else you'd like to know?"
          : "Hey! Ask me anything about this video and I'll help you out. 🎬";
        await write({ type: "chunk", text: reply });
        await write({ type: "done" });
        return;
      }

      // ── Detect temporal queries ("after 5 mins", "at 10:30", etc.) ──────
      const isTemporalQuery = TIME_RE.test(message);
      const effectiveTopK   = isTemporalQuery ? TOP_K_TIME : TOP_K;

      // ── Embed the user's question ─────────────────────────────────────────
      let queryEmbedding: number[];
      try {
        queryEmbedding = await embedQuery(message, apiKey);
      } catch (err) {
        console.error("[Chat] Embed query failed:", err);
        await write({ type: "error", error: "Failed to process your question. Please try again." });
        return;
      }

      const vectorStr = `[${queryEmbedding.join(",")}]`;

      // ── Cosine similarity search via pgvector ────────────────────────────
      type ChunkRow = { text: string; chunkIndex: number; similarity: number };

      const chunks = await prisma.$queryRaw<ChunkRow[]>`
        SELECT
          text,
          "chunkIndex",
          1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM "TranscriptChunk"
        WHERE
          "videoId" = ${videoId}
          AND "userId" = ${auth.userId}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${effectiveTopK}
      `;

      if (chunks.length === 0) {
        await write({
          type: "error",
          error: "I don't have enough information about this video yet. Try summarizing it first, then ask your question.",
        });
        return;
      }

      // ── Low-similarity detection ─────────────────────────────────────────
      const topSimilarity = chunks[0]?.similarity ?? 0;
      const lowConfidence = topSimilarity < 0.35;

      // ── Build context — plain text blocks ────────────────────────────────
      const context = chunks
        .map(c => c.text.trim())
        .join("\n\n---\n\n");

      console.log(
        "[Chat] %d chunks retrieved for videoId=%s (top similarity=%.2f, temporal=%s)",
        chunks.length, videoId, topSimilarity, isTemporalQuery
      );

      // ── System prompt — LLM responds as if it personally watched the video ─
      const temporalHint = isTemporalQuery
        ? "\n6. For questions about specific timestamps or time positions: the video content below represents sections of the video. If you can identify relevant moments, describe them. If the exact moment isn't clear, say you don't recall the exact timing but share what you do know."
        : "";
      const confidenceHint = lowConfidence
        ? "\n7. The user may be asking about something very specific or niche. If you cannot find a clear answer in the content below, be honest: say you're not sure or that part wasn't very detailed in the video."
        : "";

      // Include prior conversation so the LLM can handle follow-up questions
      const historyBlock = history.length > 0
        ? `\n\nCONVERSATION HISTORY (earlier in this chat session):\n${history
            .map(h => `${h.role === "user" ? "User" : "You"}: ${h.content}`)
            .join("\n")}\n\nNow respond to the latest message:`
        : "";

      const systemPrompt = `You are a knowledgeable AI assistant who has thoroughly watched and understood a YouTube video. Your job is to answer questions about it naturally and helpfully.

CRITICAL RULES — follow without exception:
1. Speak as if you personally watched the video. NEVER use the words "transcript", "excerpt", "chunk", "context", "passage", "according to", "based on", or any phrase that suggests you are reading text.
2. If the answer is in the video content below, answer directly and confidently in your own words.
3. If the information is not covered, say: "That part wasn't covered in the video" or "I don't recall that being mentioned."
4. Keep answers concise and conversational. 2–4 sentences unless the question needs more detail.
5. Do not start with filler like "Certainly!", "Sure!", "Great question!", or "Of course!".${temporalHint}${confidenceHint}${historyBlock}

VIDEO CONTENT:
${context}`;


      // 6. Stream LLM answer via the existing callWithFallback chain
      await callWithFallback(message, {
        systemPrompt,
        userId:      auth.userId,
        temperature: 0.3,   // lower temp for factual Q&A
        maxTokens:   1024,
        onChunk: async (chunk: string) => {
          await write({ type: "chunk", text: chunk });
        },
      });

      await write({ type: "done" });
    } catch (err) {
      console.error("[Chat] Unhandled error:", err);
      await write({ type: "error", error: "An unexpected error occurred. Please try again." });
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new NextResponse(stream.readable, {
    status: 200,
    headers: {
      "Content-Type":                "text/event-stream",
      "Cache-Control":               "no-cache",
      "Connection":                  "keep-alive",
      "X-Accel-Buffering":           "no",
      ...corsHeaders(req),
    },
  });
}
