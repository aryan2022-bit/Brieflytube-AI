"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { motion, AnimatePresence } from "framer-motion"
import { useAuth } from "@/hooks/useAuth"
import {
  Youtube, Clock, Search, History, Loader2, Globe,
  Copy, Download, Check, ChevronDown, ChevronUp, X, RefreshCw
} from "lucide-react"
import { containerVariants, itemVariants, cardHover } from "@/lib/animations"

// ── Types ────────────────────────────────────────────────────────────────────
interface LanguageVariant {
  id: string
  language: string   // ISO code e.g. "en"
  label: string      // Display name e.g. "English"
  content: string
  date: string       // ISO date string
}

interface VideoGroup {
  videoId: string
  title: string
  latestDate: string
  languages: LanguageVariant[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const LANG_FLAG: Record<string, string> = {
  en: "🇬🇧", hi: "🇮🇳", es: "🇪🇸", fr: "🇫🇷",
  de: "🇩🇪", pt: "🇧🇷", zh: "🇨🇳", ja: "🇯🇵",
  ko: "🇰🇷", ar: "🇸🇦", ru: "🇷🇺", it: "🇮🇹",
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  })
}

function stripMarkdown(md: string) {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function cleanTitle(title: string) {
  return title
    .replace(/^\*\*[^*]+\*\*[:\s]*/i, "")
    .replace(/^\*[^*]+\*[:\s]*/i, "")
    .replace(/\*\*/g, "")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^Title[:\s]+/i, "")
    .trim()
}

// ── Export helpers ────────────────────────────────────────────────────────────
function downloadTxt(content: string, videoId: string, lang: string) {
  const plain = stripMarkdown(content)
  const blob = new Blob([plain], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `brieflytube-${videoId}-${lang}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Expanded Card (modal-style inline panel) ─────────────────────────────────
function VideoCard({ group: initialGroup }: { group: VideoGroup }) {
  const [group, setGroup]       = useState(initialGroup)
  const [expanded, setExpanded] = useState(false)
  const [activeLang, setActiveLang] = useState(group.languages[0]?.language ?? "en")
  const [copied, setCopied]         = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenDone, setRegenDone]       = useState(false)

  const activeVariant = group.languages.find((l) => l.language === activeLang)
    ?? group.languages[0]

  const handleCopy = useCallback(async () => {
    if (!activeVariant) return
    await navigator.clipboard.writeText(stripMarkdown(activeVariant.content))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [activeVariant])

  const handleDownload = useCallback(() => {
    if (!activeVariant) return
    downloadTxt(activeVariant.content, group.videoId, activeVariant.language)
  }, [activeVariant, group.videoId])

  // Clears the stale cached row from the DB so the user can force-regenerate
  const handleRegenerate = useCallback(async () => {
    if (!activeVariant || regenerating) return
    setRegenerating(true)
    try {
      const res = await fetch(`/api/history/${activeVariant.id}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (res.ok) {
        // Remove this language variant from local state
        const remaining = group.languages.filter((l) => l.id !== activeVariant.id)
        setGroup((g) => ({ ...g, languages: remaining }))
        setActiveLang(remaining[0]?.language ?? "")
        setRegenDone(true)
        setTimeout(() => setRegenDone(false), 4000)
      }
    } catch (e) {
      console.error("Regenerate failed:", e)
    } finally {
      setRegenerating(false)
    }
  }, [activeVariant, regenerating, group.languages])

  const thumbnailUrl = `https://img.youtube.com/vi/${group.videoId}/mqdefault.jpg`
  const youtubeUrl   = `https://www.youtube.com/watch?v=${group.videoId}`

  return (
    <motion.div variants={itemVariants}>
      {/* Card */}
      <motion.div
        className="group relative rounded-xl overflow-hidden glass border border-border hover:border-accent-primary/50 transition-all"
        whileHover={!expanded ? cardHover : undefined}
      >
        {/* ── Thumbnail row ─────────────────────────────────────────── */}
        <div
          className="relative aspect-video cursor-pointer"
          onClick={() => setExpanded((e) => !e)}
        >
          <img
            src={thumbnailUrl}
            alt={cleanTitle(group.title)}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            onError={(e) => {
              const t = e.target as HTMLImageElement
              t.src = `https://img.youtube.com/vi/${group.videoId}/default.jpg`
            }}
          />
          {/* Overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-60 group-hover:opacity-80 transition-opacity" />

          {/* Language count badge */}
          {group.languages.length > 1 && (
            <div className="absolute top-3 left-3">
              <span className="flex items-center gap-1 bg-black/60 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-full">
                <Globe className="w-3 h-3" />
                {group.languages.length} languages
              </span>
            </div>
          )}

          {/* Expand toggle */}
          <div className="absolute top-3 right-3">
            <span className="flex items-center justify-center w-7 h-7 bg-black/50 backdrop-blur-sm text-white rounded-full">
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </span>
          </div>

          {/* Title overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-4">
            <h2 className="text-sm font-semibold text-white line-clamp-2">
              {cleanTitle(group.title)}
            </h2>
          </div>
        </div>

        {/* ── Meta row ──────────────────────────────────────────────── */}
        <div className="p-3 flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span>{formatDate(group.latestDate)}</span>
          </div>
          <a
            href={youtubeUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-red-500 hover:text-red-600 transition-colors"
          >
            <Youtube className="h-3.5 w-3.5" />
            Watch
          </a>
        </div>

        {/* ── Expanded panel ────────────────────────────────────────── */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              key="expanded"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: "easeInOut" }}
              className="overflow-hidden border-t border-border"
            >
              <div className="p-4 space-y-4">
                {/* Language pill tabs */}
                {group.languages.length > 1 && (
                  <div className="flex flex-wrap gap-2">
                    {group.languages.map((lv) => (
                      <button
                        key={lv.language}
                        onClick={() => setActiveLang(lv.language)}
                        className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium transition-all ${
                          activeLang === lv.language
                            ? "bg-accent-primary text-white shadow-sm"
                            : "bg-slate-100 dark:bg-white/10 text-muted-foreground hover:bg-slate-200 dark:hover:bg-white/20"
                        }`}
                      >
                        <span>{LANG_FLAG[lv.language] ?? "🌐"}</span>
                        {lv.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Summary text */}
                {activeVariant && (
                  <div className="text-sm text-foreground leading-relaxed max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 dark:bg-white/5 p-3 border border-border">
                    {stripMarkdown(activeVariant.content)}
                  </div>
                )}

                {/* Export buttons + Regenerate + View detail link */}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={handleDownload}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download .txt
                  </button>
                  {/* Regenerate — clears stale cached row so user can re-summarize fresh */}
                  {activeVariant && (
                    <button
                      onClick={handleRegenerate}
                      disabled={regenerating}
                      title="Clear this language's cached summary so you can regenerate it fresh from the extension"
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-orange-300 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? "animate-spin" : ""}`} />
                      {regenerating ? "Clearing…" : "Regenerate"}
                    </button>
                  )}
                  {regenDone && (
                    <span className="text-xs text-orange-500">
                      ✓ Cleared — open the extension on YouTube to regenerate.
                    </span>
                  )}
                  {activeVariant && !regenDone && (
                    <Link
                      href={`/history/${activeVariant.id}`}
                      className="ml-auto text-xs text-accent-primary hover:underline"
                    >
                      Full view →
                    </Link>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const router = useRouter()
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const [videos, setVideos]   = useState<VideoGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.replace("/login")
  }, [authLoading, isAuthenticated, router])

  useEffect(() => {
    if (!isAuthenticated) return
    ;(async () => {
      try {
        const res = await fetch("/api/history", { credentials: "include" })
        if (!res.ok) throw new Error("Failed to fetch history")
        const data = await res.json()
        setVideos(data.videos ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load history")
      } finally {
        setLoading(false)
      }
    })()
  }, [isAuthenticated])

  const filtered = videos.filter((v) =>
    cleanTitle(v.title).toLowerCase().includes(searchQuery.toLowerCase())
  )

  // ── Loading states ──────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="min-h-screen gradient-soft-animated flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent-primary" />
      </div>
    )
  }
  if (!isAuthenticated) return null

  if (loading) {
    return (
      <div className="min-h-screen gradient-soft-animated p-4 md:p-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-10">
            <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight mb-4 text-slate-900 dark:text-white">
              Summary <span className="text-gradient">History</span>
            </h1>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="aspect-video rounded-xl skeleton-shimmer" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen gradient-soft-animated flex items-center justify-center p-8">
        <div className="card-elevated p-8 text-center max-w-md">
          <X className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen gradient-soft-animated p-4 md:p-8">
      <motion.div
        className="max-w-6xl mx-auto"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Header */}
        <motion.div variants={itemVariants} className="text-center mb-10">
          <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight mb-4 text-slate-900 dark:text-white">
            Summary <span className="text-gradient">History</span>
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-3 text-base max-w-md mx-auto">
            Browse your summaries — expand any card to switch languages, copy, or export.
          </p>
        </motion.div>

        {/* Search */}
        <motion.div variants={itemVariants} className="mb-8">
          <div className="card-elevated p-4 md:p-6">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400" />
              <input
                type="text"
                placeholder="Search summaries..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-12 pl-12 pr-4 rounded-xl bg-slate-50/80 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
            </div>
          </div>
        </motion.div>

        {/* Grid */}
        {filtered.length === 0 ? (
          <motion.div variants={itemVariants}>
            <div className="card-elevated p-12 text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-100 dark:bg-white/10 mb-4">
                <History className="w-8 h-8 text-slate-400" />
              </div>
              <p className="text-slate-500 dark:text-slate-400">
                {searchQuery ? "No summaries match your search." : "No summaries yet. Try summarizing some videos!"}
              </p>
            </div>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((group) => (
              <VideoCard key={group.videoId} group={group} />
            ))}
          </div>
        )}
      </motion.div>
    </div>
  )
}
