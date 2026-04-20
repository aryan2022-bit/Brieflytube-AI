import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/apiAuth";

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English", hi: "Hindi",   es: "Spanish",  fr: "French",
  de: "German",  pt: "Portuguese", zh: "Chinese", ja: "Japanese",
  ko: "Korean",  ar: "Arabic",  ru: "Russian",  it: "Italian",
};

/** Returns true if a stored title is just a generated fallback, not a real title. */
function isGenericTitle(t: string | null | undefined): boolean {
  if (!t || t.trim() === "") return true;
  if (t === "Untitled Summary") return true;
  if (/^Video Summary\s*[-–]\s*/i.test(t)) return true;
  if (/^Video\s+[A-Za-z0-9_-]{6,}$/i.test(t)) return true;
  return false;
}

/**
 * Try to extract a real title from the LLM-generated summary content.
 * Mirrors the patterns used in extractTitleFromSummary() in the summarize route.
 */
function extractTitleFromContent(content: string): string | null {
  // Same patterns the LLM prompt uses — **Title**: [text]
  const patterns = [
    /\*\*Title\*\*:\s*(.+)/i,
    /^Title:\s*(.+)/mi,
    /^#\s+(.+)/m,
    // Non-English title variants
    /\*\*Titre\*\*:\s*(.+)/i,
    /\*\*Título\*\*:\s*(.+)/i,
    /\*\*Titel\*\*:\s*(.+)/i,
    /\*\*标题\*\*[：:]\s*(.+)/i,
    /\*\*タイトル\*\*[：:]\s*(.+)/i,
    /\*\*제목\*\*[：:]\s*(.+)/i,
  ];
  for (const pattern of patterns) {
    const m = content.match(pattern);
    if (m?.[1]) {
      return m[1]
        .replace(/\[|\]/g, "")    // remove any leftover brackets
        .replace(/\*\*/g, "")     // remove bold markers
        .trim();
    }
  }
  return null;
}

/**
 * Fetch the real YouTube video title via the free oEmbed endpoint (no API key needed).
 * Returns null on any failure so the caller can fall back gracefully.
 */
async function fetchYouTubeTitle(videoId: string): Promise<string | null> {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json() as { title?: string };
    return data.title?.trim() || null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    // Fetch all summaries for the user, newest first
    const summaries = await prisma.summary.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        videoId: true,
        title: true,
        content: true,
        language: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Group by videoId — each video gets one card with all its language versions
    const grouped = new Map<string, {
      videoId: string;
      // We might have multiple rows per video; pick the best title candidate
      candidateTitle: string | null;
      englishContent: string | null;   // content from the "en" row, if any
      anyContent: string;              // content from any row
      latestDate: Date;
      languages: { id: string; language: string; label: string; content: string; date: string }[];
    }>();

    for (const s of summaries) {
      if (!grouped.has(s.videoId)) {
        grouped.set(s.videoId, {
          videoId: s.videoId,
          candidateTitle: null,
          englishContent: null,
          anyContent: s.content,
          latestDate: s.createdAt,
          languages: [],
        });
      }
      const group = grouped.get(s.videoId)!;

      // Keep the most recent stored title as the primary candidate
      if (s.createdAt > group.latestDate) {
        group.anyContent = s.content;
        group.latestDate = s.createdAt;
        if (!isGenericTitle(s.title)) {
          group.candidateTitle = s.title;
        }
      } else if (!group.candidateTitle && !isGenericTitle(s.title)) {
        group.candidateTitle = s.title;
      }

      // Cache English content separately — it's more likely to have an English title
      if (s.language === "en") {
        group.englishContent = s.content;
      }

      group.languages.push({
        id: s.id,
        language: s.language ?? "en",
        label: LANGUAGE_LABELS[s.language ?? "en"] ?? s.language ?? "English",
        content: s.content,
        date: s.createdAt.toISOString(),
      });
    }

    // Resolve titles: stored → extract from content → YouTube oEmbed
    // Collect videos that still need a YouTube fetch
    const needsYouTubeFetch: string[] = [];
    const resolvedTitles = new Map<string, string>();

    for (const [videoId, group] of grouped) {
      // 1. Stored title (not generic)
      if (group.candidateTitle) {
        resolvedTitles.set(videoId, group.candidateTitle);
        continue;
      }
      // 2. Extract from English content first, then any content
      const contentToSearch = group.englishContent ?? group.anyContent;
      const extracted = extractTitleFromContent(contentToSearch);
      if (extracted) {
        resolvedTitles.set(videoId, extracted);
        continue;
      }
      // 3. Need YouTube oEmbed
      needsYouTubeFetch.push(videoId);
    }

    // Batch the YouTube fetches in parallel (max 5 concurrent to avoid hammering)
    if (needsYouTubeFetch.length > 0) {
      const fetches = needsYouTubeFetch.map((vid) =>
        fetchYouTubeTitle(vid).then((t) => ({ vid, t }))
      );
      const results = await Promise.all(fetches);
      for (const { vid, t } of results) {
        resolvedTitles.set(vid, t ?? vid); // last resort: video ID itself
      }
    }

    const videos = Array.from(grouped.values()).map((g) => ({
      videoId: g.videoId,
      title: resolvedTitles.get(g.videoId) ?? g.videoId,
      latestDate: g.latestDate.toISOString(),
      languages: g.languages, // already sorted newest-first from DB query
    }));

    return NextResponse.json({ videos });
  } catch (error) {
    console.error("Error fetching history:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}