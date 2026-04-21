// background.js — Step 3: URL Auto-Detection
// Watches tab navigations and automatically sends YouTube video URLs to the side panel.

// ── On install: configure the side panel ────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({
    path: "sidepanel.html",
    enabled: true,
  });
});

// ── Open the side panel when the toolbar icon is clicked ─────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Helper: check if a URL is a YouTube video ─────────────────────────
function isYouTubeVideoUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Standard: youtube.com/watch?v=...
    if (
      (u.hostname === "www.youtube.com" || u.hostname === "youtube.com") &&
      u.searchParams.has("v")
    ) {
      return true;
    }
    // Short: youtu.be/<id>
    if (u.hostname === "youtu.be" && u.pathname.length > 1) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Helper: broadcast URL to every open extension page (side panel) ──
function broadcastYouTubeUrl(url) {
  // 1. Save to storage so the side panel can retrieve it on open
  chrome.storage.local.set({ lastYouTubeUrl: url });

  // 2. Try to send a live message to the side panel (if it's already open)
  chrome.runtime.sendMessage(
    { type: "YOUTUBE_URL_DETECTED", url },
    () => {
      // Suppress "no receiver" errors — the side panel might not be open
      if (chrome.runtime.lastError) { /* expected — panel not open */ }
    }
  );
}

// ── Helper: notify panel that we left YouTube ──────────────────────────
function broadcastNotYouTube() {
  chrome.runtime.sendMessage(
    { type: "NOT_YOUTUBE_TAB" },
    () => { if (chrome.runtime.lastError) { /* panel not open */ } }
  );
}

// ── Watch for tab URL changes ─────────────────────────────────────────
// Fires when a tab finishes loading a new URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only act when the URL has been fully committed
  if (changeInfo.status !== "complete") return;

  const url = tab.url || changeInfo.url || "";

  if (isYouTubeVideoUrl(url)) {
    console.log("[YT Summarizer BG] YouTube video detected:", url);
    broadcastYouTubeUrl(url);
  } else if (url && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://")) {
    // Navigated away from YouTube to a real page
    broadcastNotYouTube();
  }
});

// ── Watch for switching to a tab that's already on YouTube ───────────
// (covers the case where you switch to an existing YouTube tab)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    const url = tab.url || "";
    if (isYouTubeVideoUrl(url)) {
      console.log("[YT Summarizer BG] Switched to YouTube tab:", url);
      broadcastYouTubeUrl(url);
    } else if (url && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://")) {
      broadcastNotYouTube();
    }
  });
});
