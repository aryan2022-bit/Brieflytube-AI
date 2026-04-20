import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/apiAuth";

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English", hi: "Hindi",   es: "Spanish",  fr: "French",
  de: "German",  pt: "Portuguese", zh: "Chinese", ja: "Japanese",
  ko: "Korean",  ar: "Arabic",  ru: "Russian",  it: "Italian",
};

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
      title: string;
      latestDate: Date;
      languages: { id: string; language: string; label: string; content: string; date: string }[];
    }>();

    for (const s of summaries) {
      if (!grouped.has(s.videoId)) {
        grouped.set(s.videoId, {
          videoId: s.videoId,
          title: s.title,
          latestDate: s.createdAt,
          languages: [],
        });
      }
      const group = grouped.get(s.videoId)!;
      // Keep the most recent title as the group title
      if (s.createdAt > group.latestDate) {
        group.title = s.title;
        group.latestDate = s.createdAt;
      }
      group.languages.push({
        id: s.id,
        language: s.language ?? "en",
        label: LANGUAGE_LABELS[s.language ?? "en"] ?? s.language ?? "English",
        content: s.content,
        date: s.createdAt.toISOString(),
      });
    }

    const videos = Array.from(grouped.values()).map((g) => ({
      videoId: g.videoId,
      title: g.title,
      latestDate: g.latestDate.toISOString(),
      languages: g.languages, // already sorted newest-first from DB query
    }));

    return NextResponse.json({ videos });
  } catch (error) {
    console.error("Error fetching history:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }
}