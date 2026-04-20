import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { authenticateRequest } from "@/lib/apiAuth"

/** Strip markdown/emoji title prefix and provide a fallback that's never "Untitled". */
function cleanStoredTitle(raw: string | null | undefined, videoId: string): string {
  if (!raw || raw.trim() === "" || raw === "Untitled Summary") {
    return `Video ${videoId}`
  }
  return raw
    .replace(/^\*\*(?:title|titel|titre|título|标题|タイトル|제목)[:\s]*\*\*\s*/i, "")
    .replace(/^\*(?:title|titel|titre|título|标题|タイトル|제목)\*[:\s]*/i, "")
    .replace(/^(?:title|titel|titre|título|标题|タイトル|제목)[:\s]+/i, "")
    .replace(/\*\*/g, "")
    .trim() || `Video ${videoId}`
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
    // Fetch all summaries (ordered newest-first)
    const [allSummaries, allContent] = await Promise.all([
      prisma.summary.findMany({
        where:   { userId: auth.userId },
        orderBy: { createdAt: "desc" },
        select:  { id: true, title: true, videoId: true, createdAt: true, language: true },
      }),
      prisma.summary.findMany({
        where:  { userId: auth.userId },
        select: { content: true },
      }),
    ])

    // ── 1. Count UNIQUE videos (not total rows) ────────────────────────────
    const uniqueVideoIds = new Set(allSummaries.map((s) => s.videoId))
    const totalVideos = uniqueVideoIds.size

    // ── 2. Word count ──────────────────────────────────────────────────────
    const wordCount = allContent.reduce(
      (acc, s) => acc + s.content.split(/\s+/).filter(Boolean).length, 0
    )

    // ── 3. Hours saved — based on UNIQUE video count ───────────────────────
    const hoursSaved = +(totalVideos * 0.25).toFixed(1)

    // ── 4. Build best title per video, preferring the English row ─────────
    //   allSummaries is desc by date, so we see the latest row first.
    //   We override with the English-language row title if one exists, since
    //   the video title in English is always displayed on the dashboard.
    const bestTitle = new Map<
      string,
      { id: string; title: string; videoId: string; createdAt: string }
    >()

    for (const s of allSummaries) {
      const existing = bestTitle.get(s.videoId)
      // Always prefer the English row's title; otherwise take the first (most recent)
      if (!existing || s.language === "en") {
        bestTitle.set(s.videoId, {
          id:        s.id,
          title:     cleanStoredTitle(s.title, s.videoId),
          videoId:   s.videoId,
          createdAt: s.createdAt.toISOString(),
        })
      }
    }

    // ── 5. 4 most recently touched UNIQUE videos ───────────────────────────
    const seen = new Set<string>()
    const recentSummaries: { id: string; title: string; videoId: string; createdAt: string }[] = []

    for (const s of allSummaries) {
      if (!seen.has(s.videoId)) {
        seen.add(s.videoId)
        recentSummaries.push(bestTitle.get(s.videoId)!)
        if (recentSummaries.length >= 4) break
      }
    }

    return NextResponse.json({ totalVideos, wordCount, hoursSaved, recentSummaries })
  } catch (err) {
    console.error("[dashboard-stats] error:", err)
    return NextResponse.json({ error: "Failed to fetch dashboard stats" }, { status: 500 })
  }
}
