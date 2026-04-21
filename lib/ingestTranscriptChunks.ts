/**
 * lib/ingestTranscriptChunks.ts
 *
 * RAG ingestion — Phase 2 (Free tier via Google Gemini REST API)
 *
 * Uses direct fetch() to the Gemini REST API to avoid SDK version issues.
 * Model: text-embedding-004 (768-dim, 1,500 free req/day).
 *
 * Always called fire-and-forget from /api/summarize — must never throw.
 */

import { prisma } from "@/lib/prisma";
import crypto from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────
const CHUNK_SIZE    = 500;  // characters per chunk
const CHUNK_OVERLAP = 75;   // overlap so context isn't lost at boundaries
const MIN_CHUNK_LEN = 40;   // discard tiny trailing fragments
const CONCURRENCY   = 5;    // parallel embed calls (well within 100 RPM free limit)

// gemini-embedding-001 produces 3072-dim vectors on this key.
const EMBED_MODELS = [
  "gemini-embedding-001",
  "gemini-embedding-2-preview",
];

// ── Chunking ──────────────────────────────────────────────────────────────────
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    // Snap to nearest sentence boundary — only when not at end of string
    if (end < text.length) {
      const from  = Math.max(end - 50, start);
      const to    = Math.min(end + 50, text.length);
      const hit   = text.slice(from, to).search(/[.!?]\s/);
      if (hit !== -1) end = from + hit + 1;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length >= MIN_CHUNK_LEN) chunks.push(chunk);

    if (end >= text.length) break;                  // reached end — stop
    const next = end - CHUNK_OVERLAP;
    start = next > start ? next : end;              // always advance
  }

  return chunks;
}

// ── Embedding via Gemini REST API (bypasses SDK version issues) ───────────────
async function embedOne(text: string, apiKey: string, model: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: {
        parts: [{ text: text.slice(0, 9000) }],
      },
      taskType: "RETRIEVAL_DOCUMENT",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini ${model} embedContent ${resp.status}: ${body}`);
  }

  const json = (await resp.json()) as { embedding: { values: number[] } };
  return json.embedding.values;
}

/** Try each model in EMBED_MODELS until one works. */
async function embedWithFallback(text: string, apiKey: string): Promise<number[]> {
  let lastErr: Error | undefined;
  for (const model of EMBED_MODELS) {
    try {
      return await embedOne(text, apiKey, model);
    } catch (err) {
      console.warn(`[RAG] Model ${model} failed, trying next…`, (err as Error).message.slice(0, 120));
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("All Gemini embedding models failed");
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function ingestTranscriptChunks({
  summaryId,
  videoId,
  userId,
  transcript,
}: {
  summaryId:  string;
  videoId:    string;
  userId:     string;
  transcript: string;
}): Promise<void> {
  console.log("[RAG] ingestTranscriptChunks called", {
    summaryId, videoId, transcriptLength: transcript?.length ?? 0,
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith("your-") || !apiKey.startsWith("AIza")) {
    console.warn("[RAG] ❌ GEMINI_API_KEY missing or invalid — get a free key at https://aistudio.google.com/app/apikey");
    return;
  }
  if (!transcript || transcript.trim().length < MIN_CHUNK_LEN) {
    console.warn("[RAG] ❌ Transcript too short, skipping");
    return;
  }

  // 1. Delete stale chunks for this summary (idempotent)
  await prisma.transcriptChunk.deleteMany({ where: { summaryId } });

  // 2. Chunk the transcript
  const chunks = chunkText(transcript);
  if (chunks.length === 0) return;

  console.log("[RAG] Embedding %d chunks via Gemini REST API (concurrency=%d)…", chunks.length, CONCURRENCY);

  // 3. Embed + insert in windows of CONCURRENCY
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batchTexts = chunks.slice(i, i + CONCURRENCY);

    const embeddings = await Promise.all(
      batchTexts.map((text) => embedWithFallback(text, apiKey))
    );

    // 4. Insert via raw SQL — Prisma can't handle the `vector` type natively
    for (let j = 0; j < batchTexts.length; j++) {
      const id        = crypto.randomUUID();
      const text      = batchTexts[j];
      const vectorStr = `[${embeddings[j].join(",")}]`; // pgvector literal

      await prisma.$executeRaw`
        INSERT INTO "TranscriptChunk"
          ("id", "summaryId", "videoId", "userId", "text", "embedding", "chunkIndex", "createdAt")
        VALUES
          (${id}, ${summaryId}, ${videoId}, ${userId}, ${text}, ${vectorStr}::vector, ${i + j}, NOW())
      `;
    }

    console.log("[RAG] Saved chunks %d–%d / %d", i + 1, Math.min(i + CONCURRENCY, chunks.length), chunks.length);
  }

  console.log("[RAG] ✓ Ingestion complete — %d chunks (summaryId=%s)", chunks.length, summaryId);
}
