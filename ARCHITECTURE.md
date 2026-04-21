# Brieflytube AI — Architecture & Workflow

> A full-stack AI-powered YouTube summarization and RAG chat system consisting of a **Next.js web dashboard** and a **Chrome Extension side panel**.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [System Architecture](#3-system-architecture)
4. [Database Schema](#4-database-schema)
5. [Feature Workflows](#5-feature-workflows)
   - [5.1 Summarization Flow](#51-summarization-flow)
   - [5.2 RAG Ingestion Flow](#52-rag-ingestion-flow-background)
   - [5.3 Chat with Video Flow](#53-chat-with-video-rag-flow)
   - [5.4 Authentication Flow](#54-authentication-flow)
   - [5.5 History & Dashboard Flow](#55-history--dashboard-flow)
6. [Chrome Extension Architecture](#6-chrome-extension-architecture)
7. [API Routes Reference](#7-api-routes-reference)
8. [Environment Variables](#8-environment-variables)
9. [Data Flow Diagram](#9-data-flow-diagram)

---

## 1. Project Overview

**Brieflytube AI** lets users paste any YouTube URL and instantly get:
- An AI-generated summary in **12 languages**
- **Clickable timestamp chapters** that seek the video player
- A **"Chat with the Video"** interface powered by RAG (Retrieval-Augmented Generation)
- A personal **history dashboard** showing all past summaries

The product has two surfaces:
| Surface | Technology | Entry Point |
|---------|------------|-------------|
| Web Dashboard | Next.js 14 App Router | `localhost:3000` |
| Chrome Extension | Plain HTML/CSS/JS | Side Panel |

---

## 2. Tech Stack

### Frontend
| Layer | Technology | Purpose |
|-------|------------|---------|
| Web Framework | **Next.js 14** (App Router) | SSR, API routes, page routing |
| UI Animations | **Framer Motion** | Dashboard card animations |
| Icons | **Lucide React** | Consistent icon library |
| Styling | **Vanilla CSS** (CSS variables) | Dashboard & extension |
| Extension UI | **Plain HTML/CSS/JS** | Chrome side panel |

### Backend (Next.js API Routes)
| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | **Node.js** (via Next.js) | Server-side API processing |
| ORM | **Prisma v7** | Type-safe DB access |
| Auth | **Better Auth** | Session management |
| Streaming | **Server-Sent Events (SSE)** | Real-time summary & chat streaming |

### AI / ML
| Component | Technology | Purpose |
|-----------|------------|---------|
| LLM (Summary & Chat) | **GLM-4.7 Flash** (ZAI API) | Text summarisation, Q&A answers |
| Embedding Model | **gemini-embedding-001** (Google Gemini) | 3072-dim vector embeddings |
| Vector Search | **pgvector** (PostgreSQL extension) | Cosine similarity search |

### Database & Storage
| Component | Technology | Purpose |
|-----------|------------|---------|
| Primary DB | **Supabase PostgreSQL** | All persistent data |
| Vector Store | **pgvector** extension | Transcript embeddings |
| ORM Client | **Prisma** (generated client) | Type-safe queries |

### Infrastructure
| Component | Technology |
|-----------|------------|
| Database Host | Supabase (AWS ap-southeast-1) |
| Dev Server | `npm run dev` (Next.js) |
| Extension | Chrome Extension Manifest V3 |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACES                             │
│                                                                     │
│   ┌──────────────────────┐        ┌────────────────────────────┐   │
│   │  Chrome Extension     │        │   Next.js Web Dashboard    │   │
│   │  (sidepanel.html/js)  │        │   (app/  — App Router)     │   │
│   │                       │        │                            │   │
│   │  • URL input          │        │  • /           (home)      │   │
│   │  • Summary/Chat tabs  │        │  • /history    (summaries) │   │
│   │  • Timestamp seek     │        │  • /dashboard  (stats)     │   │
│   └──────────┬───────────┘        └──────────────┬─────────────┘   │
│              │ HTTP (credentials:include)          │ HTTP            │
└──────────────┼─────────────────────────────────────┼───────────────┘
               │                                     │
               ▼                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      NEXT.JS API LAYER                              │
│                                                                     │
│   /api/summarize   /api/chat   /api/history   /api/dashboard-stats  │
│   /api/auth/*      /api/health /api/user/*    /api/proxy            │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                     lib/ (shared)                           │   │
│   │  llmChain.ts │ ingestTranscriptChunks.ts │ prisma.ts │ glm  │   │
│   └─────────────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────────────────────┬──────────────┘
               │                                      │
               ▼                                      ▼
┌─────────────────────────┐            ┌──────────────────────────────┐
│    EXTERNAL AI APIs     │            │    SUPABASE POSTGRESQL       │
│                         │            │    (+ pgvector extension)    │
│  ┌─────────────────┐    │            │                              │
│  │ ZAI / GLM-4.7   │    │            │  Tables:                     │
│  │ Flash (LLM)     │    │            │  • User, Account, Session    │
│  └─────────────────┘    │            │  • Summary                   │
│                         │            │  • Topic                     │
│  ┌─────────────────┐    │            │  • TranscriptSegment         │
│  │ Google Gemini   │    │            │  • TranscriptChunk (vector)  │
│  │ embeddings API  │    │            │  • AppConfig, ApiUsageLog    │
│  └─────────────────┘    │            │                              │
└─────────────────────────┘            └──────────────────────────────┘
```

---

## 4. Database Schema

### Core Models

```
Summary
────────────────────────────────────────────
id            String   (cuid, PK)
videoId       String   (YouTube video ID)
userId        String   (FK → User)
title         String   (video title)
content       String   (full markdown summary)
language      String   (ISO code, e.g. "en")
hasTimestamps Boolean
modelUsed     String   (LLM model name)
createdAt     DateTime

Topic
────────────────────────────────────────────
id            String   (PK)
summaryId     String   (FK → Summary)
title         String
startMs       Int
endMs         Int
order         Int

TranscriptSegment
────────────────────────────────────────────
id            String   (PK)
summaryId     String   (FK → Summary)
text          String
offset        Int      (ms)
duration      Int      (ms)
order         Int

TranscriptChunk                          ← RAG table
────────────────────────────────────────────
id            String    (PK)
summaryId     String    (FK → Summary)
videoId       String    (denormalised for fast lookup)
userId        String    (scoped per user)
text          String    (raw ~500-char chunk)
embedding     vector(3072)   ← pgvector column
chunkIndex    Int       (order within transcript)
createdAt     DateTime
```

### Auth Models (Better Auth)
`User` · `Account` · `Session` · `Verification` · `SecurityQuestion` · `UserSecurityQuestion`

### Config Models
`AppConfig` · `ApiUsageLog` · `UserApiKey` · `UserTopicEdit`

---

## 5. Feature Workflows

### 5.1 Summarization Flow

```
User pastes YouTube URL
        │
        ▼
Extension / Web App → POST /api/summarize
        │  { url, language, model, detailLevel }
        │
        ▼
┌─────────────────────────────────────────┐
│  /api/summarize  (SSE streaming route)  │
│                                         │
│  1. Authenticate user (session cookie)  │
│  2. Extract videoId from URL            │
│  3. Cache lookup (Summary table)        │
│     ├─ HIT  → stream cached content     │
│     └─ MISS → continue ↓               │
│                                         │
│  4. Fetch YouTube transcript            │
│     (captions API → parse XML/JSON)     │
│                                         │
│  5. Build LLM prompt with:              │
│     • Transcript text                   │
│     • Language instruction              │
│     • Detail level                      │
│     • Timestamp format rules            │
│                                         │
│  6. callWithFallback(prompt, options)   │
│     └─ GLM-4.7 Flash (ZAI API)         │
│        Streams chunks → SSE events      │
│                                         │
│  7. Save Summary + Topics to DB         │
│  8. Write SSE "complete" event          │
│                                         │
│  9. Fire-and-forget:                    │
│     ingestTranscriptChunks(...)  ─────► │ (see §5.2)
└─────────────────────────────────────────┘
        │
        ▼
Extension renders markdown → HTML
• Clickable timestamps seek YouTube player
• Tab bar: Summary | Chat unlocked
```

**SSE Event Types:**

| Event Type | When Sent | Payload |
|---|---|---|
| `progress` | Stage changes | `{ stage, message }` |
| `stream_chunk` | Each LLM token | `{ chunk }` |
| `complete` | Fully done | `{ summary: { id, videoId, content, topics, … } }` |
| `error` | Any failure | `{ error }` |

---

### 5.2 RAG Ingestion Flow (Background)

Runs **fire-and-forget** after every cache MISS summary generation. Never blocks the user-facing response.

```
ingestTranscriptChunks({ summaryId, videoId, userId, transcript })
        │
        ▼
1. Validate GEMINI_API_KEY (must start with "AIza")
2. DELETE stale chunks for this summaryId (idempotent)
3. chunkText(transcript)
   ├─ Split into ~500-char chunks
   ├─ Snap boundaries to sentence endings (. ! ?)
   ├─ 75-char overlap between chunks
   └─ Discard chunks < 40 chars
        │
        ▼
4. For each batch of 5 chunks (concurrent):
   │
   ├─ POST https://generativelanguage.googleapis.com/
   │       v1beta/models/gemini-embedding-001:embedContent
   │       { content: { parts: [{ text }] },
   │         taskType: "RETRIEVAL_DOCUMENT" }
   │       → returns float[] of length 3072
   │
   └─ INSERT INTO "TranscriptChunk"
         (id, summaryId, videoId, userId, text,
          embedding::vector, chunkIndex, createdAt)
        │
        ▼
5. Log: "[RAG] ✓ Ingestion complete — N chunks"
```

**Key design decisions:**
- Concurrency = 5 (well within Gemini free tier 100 RPM)
- Idempotent: re-summarizing the same video replaces old chunks
- Fire-and-forget: crashes here never affect the user's summary

---

### 5.3 Chat with Video (RAG) Flow

```
User types question in Chat tab → presses Enter / Send
        │
        ▼
Extension → POST /api/chat
        │  { message: "What is this about?", videoId: "abc123" }
        │  credentials: "include" (session cookie)
        │
        ▼
┌─────────────────────────────────────────────┐
│  /api/chat  (SSE streaming route)           │
│                                             │
│  1. Authenticate user                       │
│  2. Embed the user's question               │
│     POST gemini-embedding-001:embedContent  │
│     taskType: "RETRIEVAL_QUERY"             │
│     → queryVector (3072 floats)             │
│                                             │
│  3. Vector search (pgvector):               │
│     SELECT text, chunkIndex,                │
│       1 - (embedding <=> queryVector::vector│
│       ) AS similarity                       │
│     FROM "TranscriptChunk"                  │
│     WHERE videoId = ? AND userId = ?        │
│     ORDER BY embedding <=> queryVector      │
│     LIMIT 5                                 │
│                                             │
│  4. Build context string from top-5 chunks  │
│     "[Excerpt 1 — relevance 87%]: ..."      │
│                                             │
│  5. System prompt injection:                │
│     "Answer ONLY from transcript excerpts.  │
│      [TRANSCRIPT EXCERPTS]: {context}"      │
│                                             │
│  6. callWithFallback(question, {            │
│       systemPrompt, userId,                 │
│       temperature: 0.3,                     │
│       maxTokens: 1024,                      │
│       onChunk: stream → SSE                │
│     })                                      │
│                                             │
│  7. Write SSE "done" event                  │
└─────────────────────────────────────────────┘
        │
        ▼
Extension streams text token-by-token
• Blinking cursor during generation
• Final answer rendered in AI bubble
```

**RAG Chat SSE Events:**

| Event Type | Payload |
|---|---|
| `chunk` | `{ text: "partial answer..." }` |
| `done` | `{}` |
| `error` | `{ error: "message" }` |

---

### 5.4 Authentication Flow

```
User visits localhost:3000
        │
        ▼
Better Auth middleware checks session cookie
        ├─ Valid  → proceed to page
        └─ Invalid → redirect to /auth/login
                          │
                          ▼
                   Email + Password login
                          │
                          ▼
                   Better Auth creates session
                   Sets HTTP-only cookie
                          │
                          ▼
        Extension uses credentials:"include"
        → browser automatically sends the
          session cookie with every fetch()
          to localhost:3000/api/*
```

---

### 5.5 History & Dashboard Flow

```
User opens /history
        │
        ▼
GET /api/history
        │
        ▼
1. Fetch all Summaries for userId (ordered by date)
2. Group by videoId (one entry per video, collapsible languages)
3. Title resolution waterfall:
   a. Use stored title if not a generic fallback
   b. Extract from LLM markdown (regex: **Title**: ...)
   c. Fetch from YouTube oEmbed API (free, no key needed)

        │
        ▼
Return grouped VideoGroups[] → render cards

GET /api/dashboard-stats
        │
        ▼
1. COUNT(DISTINCT videoId) → videos summarised
2. COUNT(*) summaries this week
3. Most used language
4. Recent summaries (last 6, with title resolution)
```

---

## 6. Chrome Extension Architecture

```
extension/
├── manifest.json          ← MV3, side_panel permission
├── background.js          ← Service worker
│                             Detects YouTube tab changes
│                             Sends YOUTUBE_URL_DETECTED message
├── sidepanel.html         ← Main UI entry point
├── sidepanel.js           ← All UI logic
│   ├── Theme system        (dark/light, localStorage)
│   ├── URL detection       (auto-fill from active tab)
│   ├── Summarize flow      (fetch → SSE → render)
│   ├── makeTimestampsClickable()
│   ├── seekYouTubeTo()     (chrome.scripting.executeScript)
│   └── Chat system (Phase 4)
│       ├── switchToTab()
│       ├── initChat(videoId)
│       ├── appendMessage(role, text)
│       └── sendChatMessage()  (fetch → SSE streaming)
├── sidepanel.css          ← Dual-theme design system
│   ├── CSS variables       (--accent, --bg, --text-*)
│   ├── Component styles    (tabs, cards, inputs, buttons)
│   └── Chat UI styles      (bubbles, input bar, cursor)
└── icons/
    └── icon48.png, icon128.png
```

### Extension ↔ API Communication

| Call | Endpoint | Auth Method |
|------|----------|-------------|
| Summarize video | `POST /api/summarize` | Session cookie |
| Chat with video | `POST /api/chat` | Session cookie |
| Health check | `GET /api/health` | None |

All extension fetch calls use `credentials: "include"` so the browser automatically supplies the Better Auth session cookie set during dashboard login.

---

## 7. API Routes Reference

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST` | `/api/summarize` | Generate & stream summary | ✅ Required |
| `POST` | `/api/chat` | RAG chat, stream answer | ✅ Required |
| `GET` | `/api/history` | All past summaries (grouped) | ✅ Required |
| `GET` | `/api/dashboard-stats` | Stats + recent summaries | ✅ Required |
| `GET` | `/api/health` | Server heartbeat | ❌ Public |
| `GET/POST` | `/api/auth/*` | Better Auth handlers | — |
| `GET` | `/api/user/setup-status` | Check user config | ✅ Required |
| `ANY` | `/api/proxy` | GLM API proxy | ✅ Required |

---

## 8. Environment Variables

```env
# Database
DATABASE_URL=postgresql://...supabase.com:5432/postgres

# Auth
BETTER_AUTH_SECRET=<random 32+ char string>
BETTER_AUTH_URL=http://localhost:3000

# AI — LLM
GLM_API_KEY=<ZAI platform key>

# AI — Embeddings (RAG)
GEMINI_API_KEY=AIza...   # Google AI Studio free key
                          # https://aistudio.google.com/app/apikey
```

---

## 9. Data Flow Diagram

```
YouTube URL entered by user
          │
          ▼
┌─────────────────┐     transcript text     ┌────────────────────┐
│  /api/summarize  │ ──────────────────────► │  GLM-4.7 Flash LLM │
│  (Next.js route) │ ◄────── SSE chunks ──── │  (ZAI API)         │
└────────┬─────────┘                         └────────────────────┘
         │ save summary
         ▼
┌─────────────────────┐
│  Supabase Postgres   │
│                      │
│  Summary table  ◄────┤
│  Topic table    ◄────┤
│  TranscriptSeg  ◄────┤
│                      │
│  (background)        │
│                      │    embed each chunk
│  TranscriptChunk◄────┼──────────────────────► Gemini API
│  [vector(3072)]      │ ◄── float[3072] ──────  gemini-embedding-001
└──────────┬───────────┘
           │
           │  at chat time: cosine similarity search
           ▼
┌─────────────────┐    top-5 chunks + question   ┌────────────────────┐
│  /api/chat       │ ──────────────────────────► │  GLM-4.7 Flash LLM │
│  (Next.js route) │ ◄──── SSE answer chunks ─── │  (ZAI API)         │
└─────────────────┘                              └────────────────────┘
           │
           ▼
   Extension chat bubble streams answer in real-time
```

---

## Summary of Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **SSE over WebSockets** | Simpler for unidirectional streaming; works with Next.js serverless model |
| **Fire-and-forget ingestion** | RAG embedding never blocks the user's summary response |
| **Gemini embeddings (free tier)** | 1,500 req/day free, no billing required; `gemini-embedding-001` produces 3072-dim vectors |
| **pgvector in Supabase** | No separate vector DB needed; Supabase enables the extension with one SQL command |
| **Prisma `$executeRaw` for inserts** | Prisma doesn't natively support the `vector` type; raw SQL with `::vector` cast is required |
| **Session cookies (not API keys)** | Extension reuses the dashboard login session; no separate API key management needed |
| **Language-aware caching** | Each (videoId, userId, language) combination is cached separately so switching languages is a fresh generation |
| **3-tier title resolution** | DB title → content extraction → YouTube oEmbed API prevents "Untitled Summary" in history |
