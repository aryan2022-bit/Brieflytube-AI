<div align="center">

<img src="extension/icons/icon128.png" alt="Brieflytube AI Logo" width="90" />

# Brieflytube AI

**AI-powered YouTube summarization + RAG chat — in your browser, in your language.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ecf8e?logo=supabase)](https://supabase.com/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma)](https://www.prisma.io/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)

</div>

---

## ✨ What is Brieflytube AI?

Brieflytube AI turns any YouTube video into a structured, timestamped summary and lets you **chat with the video's transcript** using a RAG (Retrieval-Augmented Generation) pipeline — all for free.

It ships as two surfaces:

| Surface | What it is |
|---------|-----------|
| 🌐 **Web Dashboard** | Next.js app for history, stats, and account management |
| 🔌 **Chrome Extension** | Side panel that works right next to any YouTube video |

---

## 🚀 Key Features

- **⚡ AI Summarization** — Stream structured summaries with chapter detection using GLM-4.7 Flash
- **🌍 12 Languages** — Summarize in English, Hindi, Spanish, French, German, Portuguese, Chinese, Japanese, Korean, Arabic, Russian, Italian
- **⏱️ Clickable Timestamps** — Jump to any moment in the video directly from the summary
- **💬 Chat with the Video** — Ask questions and get answers grounded in the transcript (RAG)
- **📋 History Dashboard** — Every summary is saved, searchable, and grouped by video
- **🔄 Smart Caching** — Instant re-load for previously summarized videos
- **🌙 Dark / Light Mode** — Fully themed extension and dashboard

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACES                             │
│                                                                     │
│   ┌──────────────────────┐        ┌────────────────────────────┐   │
│   │  Chrome Extension     │        │   Next.js Web Dashboard    │   │
│   │  (sidepanel.html/js)  │        │   (App Router)             │   │
│   └──────────┬───────────┘        └──────────────┬─────────────┘   │
│              │ HTTP (session cookie)               │ HTTP            │
└──────────────┼─────────────────────────────────────┼───────────────┘
               ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      NEXT.JS API LAYER                              │
│   /api/summarize  ·  /api/chat  ·  /api/history  ·  /api/auth/*    │
└──────────────┬──────────────────────────────────────┬──────────────┘
               │                                      │
               ▼                                      ▼
┌─────────────────────────┐            ┌──────────────────────────────┐
│    EXTERNAL AI APIs     │            │    SUPABASE POSTGRESQL       │
│                         │            │    + pgvector extension      │
│  • GLM-4.7 Flash (LLM)  │            │                              │
│  • Gemini Embeddings    │            │  Summary · Topic · Transcript│
│    (gemini-embedding-   │            │  Chunk (vector 3072-dim)     │
│     001, 3072 dims)     │            │  User · Session · Auth       │
└─────────────────────────┘            └──────────────────────────────┘
```

---

## 🛠️ Tech Stack

### Frontend
| Layer | Technology |
|-------|-----------|
| Web Framework | **Next.js 14** (App Router, SSR) |
| Extension UI  | **HTML / CSS / Vanilla JS** (Chrome MV3 Side Panel) |
| Animations    | **Framer Motion** |
| Icons         | **Lucide React** |

### Backend
| Layer | Technology |
|-------|-----------|
| Runtime   | **Node.js** via Next.js API routes |
| ORM       | **Prisma v7** |
| Auth      | **Better Auth** (HTTP-only session cookies) |
| Streaming | **Server-Sent Events (SSE)** |

### AI / ML
| Component | Technology |
|-----------|-----------|
| LLM (summaries & chat)  | **GLM-4.7 Flash** (ZAI API) |
| Embedding model         | **gemini-embedding-001** (Google Gemini, free tier) |
| Vector search           | **pgvector** cosine similarity (`<=>` operator) |

### Database
| Component | Technology |
|-----------|-----------|
| Primary database | **Supabase PostgreSQL** |
| Vector store     | **pgvector** extension (`vector(3072)`) |

---

## 🔄 How It Works — Step by Step

### 1️⃣ Summarization Flow

```
User pastes YouTube URL
         │
         ▼
POST /api/summarize { url, language, model }
         │
         ├─► Cache lookup (Summary table)
         │     ├─ HIT  → stream cached content instantly
         │     └─ MISS → continue ↓
         │
         ├─► Fetch YouTube transcript (captions API)
         │
         ├─► Build LLM prompt (transcript + language + rules)
         │
         ├─► GLM-4.7 Flash streams tokens → SSE events
         │     progress → stream_chunk → complete
         │
         ├─► Save Summary + Topics to Supabase
         │
         └─► 🔥 Fire-and-forget: ingestTranscriptChunks()
                  (RAG background ingestion — see below)
```

### 2️⃣ RAG Ingestion (Background)

Runs silently after every new summary. Never blocks the user.

```
transcript text
         │
         ▼
chunkText() → ~500-char chunks (75-char overlap, sentence-snapped)
         │
         ▼
For each batch of 5 chunks (concurrent):
  POST gemini-embedding-001:embedContent { taskType: RETRIEVAL_DOCUMENT }
  → float[3072] embedding vector
         │
         ▼
INSERT INTO TranscriptChunk (text, embedding::vector, summaryId, ...)
         │
         ▼
[RAG] ✓ Ingestion complete — N chunks saved to pgvector
```

### 3️⃣ Chat with the Video (RAG)

```
User types question in Chat tab
         │
         ▼
POST /api/chat { message, videoId }
         │
         ├─► Embed query: gemini-embedding-001 (taskType: RETRIEVAL_QUERY)
         │     → queryVector [3072 floats]
         │
         ├─► pgvector cosine similarity search
         │     SELECT text, 1 - (embedding <=> queryVector) AS similarity
         │     FROM TranscriptChunk WHERE videoId=? AND userId=?
         │     ORDER BY similarity DESC LIMIT 5
         │
         ├─► Build context from top-5 chunks
         │
         ├─► System prompt: "Answer ONLY from transcript excerpts..."
         │
         └─► GLM-4.7 Flash streams answer → SSE → Extension chat bubble
```

---

## 📁 Project Structure

```
brieflytube-ai/
├── app/                        # Next.js App Router
│   ├── api/
│   │   ├── summarize/route.ts  # Core SSE summarization + cache
│   │   ├── chat/route.ts       # RAG chat API (vector search + LLM)
│   │   ├── history/route.ts    # Summary history with title resolution
│   │   └── dashboard-stats/   # Dashboard statistics
│   ├── history/page.tsx        # History page (grouped by video)
│   └── dashboard/page.tsx      # Stats dashboard
│
├── lib/
│   ├── ingestTranscriptChunks.ts  # RAG ingestion (embed + pgvector insert)
│   ├── llmChain.ts                # LLM fallback chain (GLM-4.7)
│   └── prisma.ts                  # Prisma client singleton
│
├── prisma/
│   └── schema.prisma              # DB schema (includes TranscriptChunk)
│
├── extension/                  # Chrome Extension (MV3)
│   ├── manifest.json
│   ├── sidepanel.html          # Extension UI
│   ├── sidepanel.js            # All logic: summarize, timestamps, chat
│   ├── sidepanel.css           # Dual-theme design system
│   └── background.js           # URL detection service worker
│
├── ARCHITECTURE.md             # Full architecture reference
└── .env                        # Environment variables
```

---

## 🗃️ Database Schema (Key Tables)

```sql
-- Core summaries
Summary        (id, videoId, userId, title, content, language, hasTimestamps)
Topic          (id, summaryId, title, startMs, endMs, order)
TranscriptSeg  (id, summaryId, text, offset, duration, order)

-- RAG vector store
TranscriptChunk (
  id, summaryId, videoId, userId,
  text          TEXT,
  embedding     vector(3072),   -- pgvector, gemini-embedding-001
  chunkIndex    INT,
  createdAt     TIMESTAMPTZ
)
```

---

## ⚙️ Local Setup

### Prerequisites
- Node.js 20+
- A [Supabase](https://supabase.com) project (free tier works)
- A [ZAI / GLM](https://z.ai) API key
- A [Google AI Studio](https://aistudio.google.com/app/apikey) API key (free)

### 1. Clone & Install

```bash
git clone https://github.com/aryan2022-bit/Brieflytube-AI.git
cd Brieflytube-AI
npm install --legacy-peer-deps
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
DATABASE_URL=postgresql://...supabase.com:5432/postgres

BETTER_AUTH_SECRET=<run: openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000

GLM_API_KEY=<your ZAI key>
GEMINI_API_KEY=AIza...   # from aistudio.google.com/app/apikey
```

### 3. Set Up Database

Run once in the **Supabase SQL Editor**:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Then sync the schema:

```bash
npx prisma generate
npx prisma db push
```

### 4. Run

```bash
npm run dev
# → http://localhost:3000
```

### 5. Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Open any YouTube video → click the Brieflytube AI side panel icon

---

## 🔐 Authentication

- **Better Auth** handles registration, login, and session management
- Sessions use **HTTP-only cookies** — secure against XSS
- The Chrome Extension uses `credentials: "include"` on every fetch to automatically forward the browser session cookie — no separate API key required

---

## 🌐 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Supabase PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | ✅ | 32+ char random secret for session signing |
| `BETTER_AUTH_URL` | ✅ | Base URL (`http://localhost:3000` in dev) |
| `GLM_API_KEY` | ✅ | ZAI platform key for GLM-4.7 Flash |
| `GEMINI_API_KEY` | ✅ | Google AI Studio key (free tier, `AIza...`) |

---

## 📄 License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built with ❤️ by [Aryan Prasad](https://github.com/aryan2022-bit)

</div>
