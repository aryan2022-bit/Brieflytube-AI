import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/apiAuth";

type Props = { params: Promise<{ id: string }> }

// ── GET /api/history/[id] ─────────────────────────────────────────────────────
export async function GET(request: NextRequest, { params }: Props): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Summary ID is required" }, { status: 400 });

    const summary = await prisma.summary.findUnique({
      where: { id, userId: auth.userId },
      include: {
        topics:             { orderBy: { order: "asc" } },
        transcriptSegments: { orderBy: { order: "asc" } },
      },
    });

    if (!summary) return NextResponse.json({ error: "Summary not found" }, { status: 404 });

    // Use the stored title as-is — it was properly set during generation.
    // Only rebuild from content if stored title is blank or generic.
    let title = summary.title?.trim()
    if (!title || title === "Untitled Summary") {
      const firstLine = summary.content.split("\n").find((l) => l.trim().length > 0) ?? ""
      title = firstLine
        .replace(/^(?:🎯|🎙️?)\s*(TITLE|TITEL)[:\s]*/i, "")
        .replace(/\*\*/g, "")
        .trim() || `Video ${summary.videoId}`
    }

    return NextResponse.json({
      summary: { ...summary, title, youtubeTitle: title, youtubeThumbnail: null, youtubeDescription: "" },
    });
  } catch (error) {
    console.error("Error fetching summary:", error);
    return NextResponse.json({ error: "Failed to fetch summary" }, { status: 500 });
  }
}

// ── DELETE /api/history/[id] ──────────────────────────────────────────────────
// Deletes a specific language variant by summary ID so the user can force-
// regenerate it fresh from the extension (bypassing the stale cache).
export async function DELETE(request: NextRequest, { params }: Props): Promise<Response> {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Summary ID is required" }, { status: 400 });

    // Verify ownership before deleting
    const summary = await prisma.summary.findUnique({
      where:  { id },
      select: { userId: true, language: true, videoId: true },
    });

    if (!summary) return NextResponse.json({ error: "Summary not found" }, { status: 404 });
    if (summary.userId !== auth.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await prisma.summary.delete({ where: { id } });

    return NextResponse.json({
      success: true,
      message: `Cleared ${summary.language} summary — regenerate it from the extension.`,
    });
  } catch (error) {
    console.error("Error deleting summary:", error);
    return NextResponse.json({ error: "Failed to delete summary" }, { status: 500 });
  }
}