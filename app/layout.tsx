import type { Metadata } from "next"
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google"
import "./globals.css"
import { Sidebar, MobileSidebar } from "@/components/sidebar"
import { Providers } from "@/components/providers"
import type React from "react"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
})

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
})

export const metadata: Metadata = {
  title: "Brieflytube AI",
  description: "AI-powered YouTube video summarizer. Get instant chapter-based summaries with clickable timestamps.",
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} font-sans`}
      >
        <Providers>
          <div className="flex h-screen overflow-hidden">
            {/* Minimal Sidebar - Hidden on mobile, visible on md+ */}
            <Sidebar className="hidden md:flex" />
            {/* Mobile Sidebar - centralized here for all pages */}
            <MobileSidebar />

            {/* Main Content Area — overflow-y-auto so history/settings pages scroll;
                dashboard page uses h-screen on its own root to prevent window scroll */}
            <main className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  )
}
