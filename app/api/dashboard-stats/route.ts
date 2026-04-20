import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { authenticateRequest } from "@/lib/apiAuth"

/** Returns true if a title is just a generated fallback, not a real one. */
function isGenericTitle(t: string | null | undefined): boolean {
  if (!t || t.trim() === "") return true;
  if (t === "Untitled Summary") return true;
  if (/^Video Summary\s*[-–]\s*/i.test(t)) return true;
  if (/^Video\s+[A-Za-z0-9_-]{6,}$/i.test(t)) return true;
  return false;
}

/** Try to extract the real title from LLM-generated content. */
function extractTitleFromContent(content: string): string | null {
  const patterns = [
    /\*\*Title\*\*:\s*(.+)/i,
    /^Title:\s*(.+)/mi,
    /^#\s+(.+)/m,
    /\*\*Titre\*\*:\s*(.+)/i,
    /\*\*Título\*\*:\s*(.+)/i,
    /\*\*Titel\*\*:\s*(.+)/i,
    /\*\*标题\*\*[：:]\s*(.+)/i,
  ];
  for (const p of patterns) {
    const m = content.match(p);
    if (m?.[1]) return m[1].replace(/\[|\]/g, "").replace(/\*\*/g, "").trim();
  }
  return null;
}

/** Fetch the YouTube video title via the free oEmbed endpoint. */
async function fetchYouTubeTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { title?: string };
    return data.title?.trim() || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req)
  if (!auth.success) {
    return new NextResponse(auth.response.body, {
      status: auth.response.status,
      headers: Object.fromEntries(auth.response.headers),
    })
  }

  try {
    // Fetch all summaries, including content for title extraction
    const allSummaries = await prisma.summary.findMany({
      where:   { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      select:  { id: true, title: true, content: true, videoId: true, createdAt: true, language: true },
    })

    // ── 1. Unique video count ──────────────────────────────────────────────
    const uniqueVideoIds = new Set(allSummaries.map((s) => s.videoId))
    const totalVideos = uniqueVideoIds.size

    // ── 2. Word count ──────────────────────────────────────────────────────
    const wordCount = allSummaries.reduce(
      (acc, s) => acc + s.content.split(/\s+/).filter(Boolean).length, 0
    )

    // ── 3. Hours saved ─────────────────────────────────────────────────────
    const hoursSaved = +(totalVideos * 0.25).toFixed(1)

    // ── 4. Best title + ID per video (prefer English row) ─────────────────
    const bestByVideo = new Map<string, { id: string; videoId: string; createdAt: string; title: string | null; content: string }>()

    for (const s of allSummaries) {
      const existing = bestByVideo.get(s.videoId)
      if (!existing || s.language === "en") {
        bestByVideo.set(s.videoId, {
          id:        s.id,
          videoId:   s.videoId,
          createdAt: s.createdAt.toISOString(),
          title:     s.title,
          content:   s.content,
        })
      }
    }

    // ── 5. 4 most recent unique videos ─────────────────────────────────────
    const seen = new Set<string>()
    const recentCandidates: typeof allSummaries = []
    for (const s of allSummaries) {
      if (!seen.has(s.videoId)) {
        seen.add(s.videoId)
        recentCandidates.push(s)
        if (recentCandidates.length >= 4) break
      }
    }

    // ── 6. Resolve titles: stored → content extraction → YouTube oEmbed ───
    const needsYouTube: string[] = []
    const resolved = new Map<string, string>()

    for (const s of recentCandidates) {
      const entry = bestByVideo.get(s.videoId)!
      if (!isGenericTitle(entry.title)) {
        resolved.set(s.videoId, entry.title!)
        continue
      }
      const extracted = extractTitleFromContent(entry.content)
      if (extracted) {
        resolved.set(s.videoId, extracted)
        continue
      }
      needsYouTube.push(s.videoId)
    }

    if (needsYouTube.length > 0) {
      const results = await Promise.all(
        needsYouTube.map((vid) => fetchYouTubeTitle(vid).then((t) => ({ vid, t })))
      )
      for (const { vid, t } of results) {
        resolved.set(vid, t ?? vid)
      }
    }

    const recentSummaries = recentCandidates.map((s) => {
      const entry = bestByVideo.get(s.videoId)!
      return {
        id:        entry.id,
        title:     resolved.get(s.videoId) ?? s.videoId,
        videoId:   s.videoId,
        createdAt: entry.createdAt,
      }
    })

    return NextResponse.json({ totalVideos, wordCount, hoursSaved, recentSummaries })
  } catch (err) {
    console.error("[dashboard-stats] error:", err)
    return NextResponse.json({ error: "Failed to fetch dashboard stats" }, { status: 500 })
  }
}
