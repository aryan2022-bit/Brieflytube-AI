"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { motion, AnimatePresence } from "framer-motion"
import { useTheme } from "next-themes"
import {
  Loader2, Sparkles, Zap, Clock, BookOpen, ArrowRight,
  Sun, Moon, Video, FileText, Edit2, Check, X,
  Play, Globe, ChevronRight,
} from "lucide-react"
import { GlassCard } from "@/components/ui/glass-card"
import { useAuth } from "@/hooks/useAuth"
import { containerVariants, itemVariants } from "@/lib/animations"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface RecentSummary {
  id: string
  title: string
  videoId: string
  createdAt: string
}

interface DashboardStats {
  totalVideos: number
  wordCount: number
  hoursSaved: number
  recentSummaries: RecentSummary[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a raw email or full name into the display name — no capitalisation change. */
function toFirstName(nameOrEmail: string): string {
  if (!nameOrEmail) return "there"
  // If it looks like an email, use the part before @
  if (nameOrEmail.includes("@")) {
    return nameOrEmail.split("@")[0]  // e.g. "aryanprasad3195"
  }
  // Otherwise return the first word of the name as-is
  return nameOrEmail.trim().split(" ")[0]
}

/** Format raw word count → "142k", "1.2M", etc. */
function formatWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Format an ISO date string to a relative / short label. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffH  = diffMs / (1000 * 60 * 60)
  const diffD  = diffH / 24

  if (diffH < 1)   return "Just now"
  if (diffH < 24)  return `${Math.floor(diffH)}h ago`
  if (diffD < 2)   return "Yesterday"
  if (diffD < 7)   return `${Math.floor(diffD)}d ago`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const CARD_COLORS = [
  "from-violet-500 to-indigo-500",
  "from-indigo-500 to-cyan-500",
  "from-teal-500 to-emerald-500",
  "from-rose-500 to-pink-500",
  "from-amber-500 to-orange-500",
  "from-fuchsia-500 to-purple-500",
]

// ─────────────────────────────────────────────────────────────────────────────
// Theme Toggle
// ─────────────────────────────────────────────────────────────────────────────
function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <div className="w-9 h-9" />

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/10 transition-all shadow-sm"
      aria-label="Toggle theme"
    >
      {theme === "dark"
        ? <Sun className="w-4 h-4 text-amber-400" />
        : <Moon className="w-4 h-4" />}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Display-name editor
// ─────────────────────────────────────────────────────────────────────────────
function DisplayNameEditor({ fallback }: { fallback: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState("")
  const [saved, setSaved]     = useState("")

  useEffect(() => {
    const stored = localStorage.getItem("brieflytube_display_name") || ""
    setSaved(stored)
    setDraft(stored)
  }, [])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed) {
      localStorage.setItem("brieflytube_display_name", trimmed)
      setSaved(trimmed)
    }
    setEditing(false)
  }

  const displayFirst = saved ? toFirstName(saved) : toFirstName(fallback)

  return (
    <div className="inline-flex items-center gap-2">
      <AnimatePresence mode="wait">
        {editing ? (
          <motion.div
            key="input"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            className="flex items-center gap-1.5"
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter")  commit()
                if (e.key === "Escape") setEditing(false)
              }}
              className="text-sm font-medium px-3 py-1 rounded-lg border border-indigo-300 dark:border-indigo-500/50 bg-white dark:bg-white/5 text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-indigo-400/30 w-36"
              placeholder="Your name"
            />
            <button onClick={commit} className="p-1 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors">
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setEditing(false)} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="display"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setEditing(true)}
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            <span>
              Welcome back,{" "}
              <span className="font-semibold text-slate-900 dark:text-white">{displayFirst}</span>!
            </span>
            <Edit2 className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat Card
// ─────────────────────────────────────────────────────────────────────────────
interface StatCardProps {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  color: string
  loading?: boolean
  delay?: number
}
function StatCard({ icon, label, value, sub, color, loading, delay = 0 }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35, ease: "easeOut" }}
      className="card-elevated p-4 flex flex-col gap-2.5 group hover:scale-[1.02] transition-transform cursor-default"
    >
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${color}`}>
        {icon}
      </div>
      {loading ? (
        <div className="space-y-1.5">
          <div className="h-6 w-14 rounded bg-slate-100 dark:bg-white/10 animate-pulse" />
          <div className="h-3.5 w-24 rounded bg-slate-100 dark:bg-white/10 animate-pulse" />
          <div className="h-3 w-20 rounded bg-slate-100 dark:bg-white/10 animate-pulse" />
        </div>
      ) : (
        <div>
          <p className="text-xl font-bold font-display text-slate-900 dark:text-white tracking-tight">{value}</p>
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mt-0.5">{label}</p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{sub}</p>
        </div>
      )}
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function Home() {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth()
  const router = useRouter()

  const [stats, setStats]         = useState<DashboardStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    if (!authLoading && isAuthenticated && user && !user.setupCompleted) {
      router.replace("/setup")
    }
  }, [authLoading, isAuthenticated, user, router])

  const fetchStats = useCallback(async () => {
    if (!isAuthenticated) return
    setStatsLoading(true)
    try {
      const res = await fetch("/api/dashboard-stats", { credentials: "include" })
      if (res.ok) setStats(await res.json())
    } catch (err) {
      console.error("Failed to load dashboard stats:", err)
    } finally {
      setStatsLoading(false)
    }
  }, [isAuthenticated])

  useEffect(() => { fetchStats() }, [fetchStats])

  // ── Loading spinner ──────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center gradient-soft-animated">
        <Loader2 className="h-8 w-8 animate-spin text-accent-primary" />
      </div>
    )
  }

  // ── Public Landing ─────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <div className="h-full overflow-y-auto gradient-soft-animated">
        <div className="min-h-full p-4 md:p-8 lg:p-12 flex flex-col">
          <header className="flex items-center justify-between mb-8 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 flex items-center justify-center">
                <Image src="/logo.png" alt="Brieflytube AI Logo" width={40} height={40} className="w-full h-full object-contain" />
              </div>
              <span className="font-display text-xl font-semibold text-slate-900 dark:text-white">Brieflytube AI</span>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <Link href="/login" className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors">Sign in</Link>
              <Link href="/register" className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-accent-primary to-accent-secondary rounded-lg hover:opacity-90 transition-opacity">Create account</Link>
            </div>
          </header>

          <motion.div className="flex-1 flex flex-col items-center justify-center max-w-4xl mx-auto w-full" variants={containerVariants} initial="hidden" animate="visible">
            <motion.div variants={itemVariants} className="text-center mb-12">
              <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-slate-900 dark:text-white mb-6">
                Transform YouTube videos into <span className="text-gradient">intelligent summaries</span>
              </h1>
              <p className="text-slate-500 dark:text-slate-400 text-lg md:text-xl max-w-2xl mx-auto mb-8">
                Get AI-powered chapter-based summaries with timestamps, topic detection, and multi-language support.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link href="/register" className="inline-flex items-center gap-2 px-8 py-4 text-lg font-semibold text-white bg-gradient-to-r from-accent-primary to-accent-secondary rounded-xl hover:opacity-90 transition-opacity shadow-lg">
                  <Sparkles className="w-5 h-5" />Get Started Free<ArrowRight className="w-5 h-5" />
                </Link>
                <Link href="/login" className="inline-flex items-center gap-2 px-8 py-4 text-lg font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors">
                  Already have an account? Sign in
                </Link>
              </div>
            </motion.div>

            <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full">
              <GlassCard variant="default" className="p-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 flex items-center justify-center mb-4"><Zap className="w-6 h-6 text-indigo-500" /></div>
                <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white mb-2">AI-Powered Analysis</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">Multiple LLM providers for intelligent summarization.</p>
              </GlassCard>
              <GlassCard variant="default" className="p-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-teal-500/20 to-teal-500/5 flex items-center justify-center mb-4"><Clock className="w-6 h-6 text-teal-500" /></div>
                <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white mb-2">Chapter Detection</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">Auto-detect topics with precise timestamps.</p>
              </GlassCard>
              <GlassCard variant="default" className="p-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-500/5 flex items-center justify-center mb-4"><BookOpen className="w-6 h-6 text-violet-500" /></div>
                <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white mb-2">Multi-Language</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">Summaries in your preferred language.</p>
              </GlassCard>
            </motion.div>
          </motion.div>
        </div>
      </div>
    )
  }

  // ── Authenticated Dashboard ── h-screen: fits viewport exactly, no window scroll ─
  return (
    <div className="h-screen flex flex-col gradient-soft-animated overflow-hidden">
      {/*
        Outer shell: h-full fills the <main> which is h-full in layout.
        flex flex-col so children stack vertically.
        overflow-hidden stops the window from growing.
      */}
      <div className="flex-1 min-h-0 flex flex-col px-4 md:px-6 lg:px-10 py-5">
        <motion.div
          className="max-w-4xl mx-auto w-full flex flex-col flex-1 min-h-0 gap-5"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >

          {/* ① Greeting + Theme Toggle — fixed, never scrolls */}
          <motion.div variants={itemVariants} className="flex items-center justify-between flex-shrink-0">
            <DisplayNameEditor fallback={user?.name || user?.email || "there"} />
            <ThemeToggle />
          </motion.div>

          {/* ② Hero headline — fixed */}
          <motion.div variants={itemVariants} className="flex-shrink-0">
            <h1 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              Briefly<span className="text-gradient">tube</span>{" "}
              <span className="text-gradient">AI</span>
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 max-w-md">
              Open YouTube, click the extension icon, get instant AI-powered summaries.
            </p>
          </motion.div>

          {/* ③ Quick Stats — fixed */}
          <motion.div variants={itemVariants} className="flex-shrink-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">Quick Stats</p>
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                icon={<Video className="w-4 h-4 text-white" />}
                label="Videos Summarized"
                value={stats ? String(stats.totalVideos) : "—"}
                sub={stats?.totalVideos === 1 ? "1 video" : `${stats?.totalVideos ?? "…"} videos`}
                color="bg-gradient-to-br from-indigo-500 to-violet-600"
                loading={statsLoading}
                delay={0.05}
              />
              <StatCard
                icon={<Clock className="w-4 h-4 text-white" />}
                label="Hours Saved"
                value={stats ? `${stats.hoursSaved}h` : "—"}
                sub="~15 min per video"
                color="bg-gradient-to-br from-teal-500 to-cyan-600"
                loading={statsLoading}
                delay={0.08}
              />
              <StatCard
                icon={<FileText className="w-4 h-4 text-white" />}
                label="Words Generated"
                value={stats ? formatWords(stats.wordCount) : "—"}
                sub="across all summaries"
                color="bg-gradient-to-br from-rose-500 to-pink-600"
                loading={statsLoading}
                delay={0.11}
              />
            </div>
          </motion.div>

          {/* ④ Extension CTA — fixed */}
          <motion.div variants={itemVariants} className="flex-shrink-0">
            <div className="card-elevated p-4 flex items-center gap-4 group hover:shadow-xl dark:hover:shadow-black/40 transition-shadow">
              <div className="w-10 h-10 flex-shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-teal-400 flex items-center justify-center shadow-md shadow-indigo-500/30">
                <Zap className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-semibold text-sm text-slate-900 dark:text-white">Use the Chrome Extension</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Go to any YouTube video → click <strong className="text-slate-700 dark:text-slate-200">Brieflytube AI</strong> → Summarize.
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0 group-hover:translate-x-1 transition-transform" />
            </div>
          </motion.div>

          {/* ⑤ Recent Summaries — flex-1 min-h-0: fills remaining space, list scrolls */}
          <motion.div variants={itemVariants} className="flex-1 min-h-0 flex flex-col">
            {/* Header row — fixed inside this section */}
            <div className="flex items-center justify-between mb-2 flex-shrink-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">Recent Summaries</p>
              <Link
                href="/history"
                className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 font-medium transition-colors flex items-center gap-1"
              >
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>

            {/* List — no scroll, max 4 cards */}
            <div className="flex-1 min-h-0">
              {statsLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="card-soft p-3.5 flex gap-3">
                      <div className="w-12 h-9 rounded-lg bg-slate-100 dark:bg-white/10 animate-pulse flex-shrink-0" />
                      <div className="flex-1 space-y-2 pt-0.5">
                        <div className="h-3 bg-slate-100 dark:bg-white/10 animate-pulse rounded" />
                        <div className="h-2.5 w-2/3 bg-slate-100 dark:bg-white/10 animate-pulse rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : !stats || stats.totalVideos === 0 ? (
                <div className="card-soft p-8 flex flex-col items-center gap-3 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-indigo-500 dark:text-indigo-400" />
                  </div>
                  <p className="font-medium text-sm text-slate-800 dark:text-slate-200">No summaries yet</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs">
                    Open any YouTube video, click the Brieflytube AI extension, and your summaries will appear here.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pb-2">
                {(stats.recentSummaries ?? []).map((s, i) => {
                    // Strip markdown and clean the title for display
                    const rawTitle = s.title ?? ""
                    const displayTitle = rawTitle
                      .replace(/^\*\*[^*]+\*\*[:\s]*/i, "")
                      .replace(/\*\*/g, "")
                      .trim()
                    // If title is still a plain video-ID fallback, show video ID as the label
                    const isTrulyUntitled = !displayTitle || /^Video\s+[A-Za-z0-9_-]{6,}$/.test(displayTitle)
                    return (
                    <Link
                      key={s.id}
                      href="/history"
                      className="card-soft-hover p-3.5 flex gap-3 group block"
                    >
                      {/* Colour thumbnail */}
                      <div className={`w-12 h-9 rounded-lg bg-gradient-to-br ${CARD_COLORS[i % CARD_COLORS.length]} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                        <Play className="w-3.5 h-3.5 text-white fill-white" />
                      </div>

                      {/* Title + date */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-slate-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors leading-snug">
                          {isTrulyUntitled ? s.videoId : displayTitle}
                        </p>
                        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 flex items-center gap-1">
                          <Globe className="w-2.5 h-2.5" />
                          {formatDate(s.createdAt)}
                        </p>
                      </div>

                      {/* Arrow */}
                      <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 self-center flex-shrink-0 group-hover:text-indigo-400 transition-colors" />
                    </Link>
                  )})
                }
                </div>
              )}
            </div>
          </motion.div>

        </motion.div>
      </div>
    </div>
  )
}
