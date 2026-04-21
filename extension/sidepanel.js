// sidepanel.js — Brieflytube AI

// ── Theme System ─────────────────────────────────────────────────────
// Reads saved preference, applies it immediately (before DOM is ready)
(function initTheme() {
  const saved = localStorage.getItem('brieflytube-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();


// ── DOM References ──────────────────────────────────────────────────
const urlInput       = document.getElementById('url-input');
const urlClear       = document.getElementById('url-clear');
const urlInputWrap   = document.getElementById('url-input-wrap');
const urlError       = document.getElementById('url-error');
const modelSelect    = document.getElementById('model-select');
const langSelect     = document.getElementById('lang-select');
const summarizeBtn   = document.getElementById('summarize-btn');
const btnContent     = document.getElementById('btn-content');
const detectBanner   = document.getElementById('detect-banner');
const detectText     = document.getElementById('detect-text');
const loadingState   = document.getElementById('loading-state');
const loadingSub     = document.querySelector('.sp-loading-sub');
const errorState     = document.getElementById('error-state');
const errorTitle     = document.getElementById('error-title');
const errorMsg       = document.getElementById('error-msg');
const resultSection  = document.getElementById('result-section');
const summaryContent = document.getElementById('summary-content');
const copyBtn        = document.getElementById('copy-btn');
const statusBadge    = document.getElementById('status-badge');
const badgeLabel     = statusBadge.querySelector('.sp-badge-label');

// ── Auto-detect which port Next.js is running on ─────────────────────
// Tries port 3000 first, falls back to 3001 (common when 3000 is taken)
let API_BASE = 'http://localhost:3000';

async function detectApiPort() {
  const ports = [3000, 3001, 3002];
  for (const port of ports) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok || res.status === 401) {
        // 401 means server is alive (just needs auth), 200 = health check passed
        API_BASE = `http://localhost:${port}`;
        console.log(`[YT Summarizer] API detected on port ${port}`);
  // Update footer port display
  const portSpan = document.getElementById('api-port');
  if (portSpan) portSpan.textContent = String(port);
  
  // Also update old footer code element if present (legacy)
  const footerCode = document.querySelector('.sp-footer code');
  if (footerCode && !portSpan) footerCode.textContent = `localhost:${port}`;
  return;
      }
    } catch { /* port not active, try next */ }
  }
  console.log('[YT Summarizer] Could not auto-detect API port. Using 3000.');
}

// ── State ────────────────────────────────────────────────────────────
let currentVideoUrl = '';

// ── URL validation ───────────────────────────────────────────────────
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return (
      (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
      u.searchParams.has('v')
    ) || (u.hostname === 'youtu.be' && u.pathname.length > 1);
  } catch {
    return false;
  }
}

function setUrlValid(valid) {
  urlInputWrap.classList.toggle('is-valid', valid);
  urlInputWrap.classList.remove('has-error');
  urlError.style.display = 'none';
  summarizeBtn.disabled = !valid;
}

function setUrlError(msg) {
  urlInputWrap.classList.remove('is-valid');
  urlInputWrap.classList.add('has-error');
  urlError.textContent = msg;
  urlError.style.display = 'block';
  summarizeBtn.disabled = true;
}

function clearUrlState() {
  urlInputWrap.classList.remove('is-valid', 'has-error');
  urlError.style.display = 'none';
  summarizeBtn.disabled = true;
}

// ── URL Input interactions ───────────────────────────────────────────
urlInput.addEventListener('input', () => {
  const val = urlInput.value.trim();
  urlClear.style.display = val ? 'flex' : 'none';
  if (!val) { clearUrlState(); currentVideoUrl = ''; return; }
  if (isYouTubeUrl(val)) { currentVideoUrl = val; setUrlValid(true); }
  else { currentVideoUrl = ''; summarizeBtn.disabled = true; }
});

urlInput.addEventListener('blur', () => {
  const val = urlInput.value.trim();
  if (val && !isYouTubeUrl(val)) setUrlError('Please enter a valid YouTube video URL');
});

urlClear.addEventListener('click', () => {
  urlInput.value = '';
  urlClear.style.display = 'none';
  clearUrlState();
  currentVideoUrl = '';
  detectBanner.style.display = 'none';
  urlInput.focus();
});

// ── Status badge helper ──────────────────────────────────────────────
function setStatus(state) {
  statusBadge.className = 'sp-header-badge';
  if (state === 'loading') { statusBadge.classList.add('loading'); badgeLabel.textContent = 'Working'; }
  else if (state === 'error') { statusBadge.classList.add('error'); badgeLabel.textContent = 'Error'; }
  else { badgeLabel.textContent = 'Ready'; }
}

// ── Show / hide panels ───────────────────────────────────────────────
function showLoading(subText = 'Fetching transcript & analyzing content') {
  loadingState.style.display  = 'flex';
  errorState.style.display    = 'none';
  resultSection.style.display = 'none';
  if (loadingSub) loadingSub.textContent = subText;
  setStatus('loading');
  btnContent.innerHTML = `<div class="sp-btn-spinner"></div><span>Generating...</span>`;
  summarizeBtn.disabled = true;
}

function showError(title, msg) {
  loadingState.style.display  = 'none';
  errorState.style.display    = 'flex';
  resultSection.style.display = 'none';
  errorTitle.textContent = title;
  errorMsg.textContent   = msg;
  setStatus('error');
  resetButton();
}

function showResult(html) {
  loadingState.style.display  = 'none';
  errorState.style.display    = 'none';
  resultSection.style.display = 'block';
  summaryContent.innerHTML    = html;

  // Always land on the Summary tab when a (new) result arrives
  const sp = document.getElementById('summary-panel');
  const cp = document.getElementById('chat-panel');
  const tS = document.getElementById('tab-summary');
  const tC = document.getElementById('tab-chat');
  if (sp) sp.style.display = '';
  if (cp) { cp.style.display = 'none'; cp.style.flexDirection = ''; }
  if (tS) tS.classList.add('sp-tab--active');
  if (tC) tC.classList.remove('sp-tab--active');

  setStatus('ready');
  resetButton();

  // Step 5 hook: make timestamps clickable
  makeTimestampsClickable();
}

function resetButton() {
  btnContent.innerHTML = `
    <svg class="sp-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936
               A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5
               A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063
               a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
    </svg>
    Summarize Video`;
  summarizeBtn.disabled = !isYouTubeUrl(urlInput.value.trim());
}

// ── Minimal Markdown → HTML renderer ────────────────────────────────
function markdownToHtml(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="sp-link">$1</a>');

  // Handle lists first so they don't get wrapped in P
  html = html.replace(/(?:^[-*] .+(?:\n|$))+/gm, (match) => {
    const items = match.trim().split('\n').map(item => `<li>${item.replace(/^[-*]\s+/, '')}</li>`).join('\n');
    return `<ul class="sp-list">\n${items}\n</ul>`;
  });

  // Ensure block-level elements are safely split into their own blocks
  html = html.replace(/(<ul[\s\S]*?<\/ul>)/gi, '\n\n$1\n\n');
  html = html.replace(/(<hr>)/gi, '\n\n$1\n\n');
  html = html.replace(/(<h[1-6]>[\s\S]*?<\/h[1-6]>)/gi, '\n\n$1\n\n');

  // Now handle paragraphs
  html = html.split(/\n\n+/).map(block => {
    if (!block.trim()) return '';
    if (block.trim().match(/^(<h|<ul|<li|<p|<hr|<div)/i)) return block.trim();
    return `<p>${block.trim().replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

// ── Copy button ──────────────────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  const text = summaryContent.innerText || summaryContent.textContent;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg> Copy`;
    }, 2000);
  });
});

// ── Toast notification (used by Step 5 seek feedback) ───────────────
let _toastTimer = null;
function showToast(message, type = 'success') {
  let toast = document.getElementById('sp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sp-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `sp-toast sp-toast--${type} sp-toast--show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.classList.remove('sp-toast--show');
  }, 2500);
}

// ═══════════════════════════════════════════════════════════════════════
// ─── STEP 5: Timestamp Sync (Capstone Feature) ──────────────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * Scans the rendered summary for two types of timestamp references:
 * 1. Anchor links with ?t=XXs  (from the API's markdown output)
 * 2. Plain-text MM:SS patterns (e.g. "01:25") not already wrapped in a link
 * Makes both types clickable — clicking seeks the YouTube video.
 */
function makeTimestampsClickable() {

  // ── 1. Handle anchor links that contain &t= (or timestamp in text) ────────
  const links = summaryContent.querySelectorAll('a.sp-link');
  links.forEach(link => {
    let seconds = null;
    
    // First, prioritize visible text over hallucinated URLs (e.g. text says "2:01")
    const textMatch = link.textContent.match(/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/);
    if (textMatch) {
      seconds = timestampToSeconds(textMatch[0]);
    } else {
      // Fallback to URL parsing if no text timestamp exists
      const href = decodeURIComponent(link.getAttribute('href') || '');
      const tMatch = href.match(/[?&]t=([0-9hms:]+)/i);
      if (tMatch) {
        seconds = 0;
        const timeStr = tMatch[1];
        if (timeStr.includes(':')) {
          seconds = timestampToSeconds(timeStr);
        } else if (/^\d+s?$/.test(timeStr)) {
          seconds = parseInt(timeStr, 10);
        } else {
          const hMatch = timeStr.match(/(\d+)h/i);
          if (hMatch) seconds += parseInt(hMatch[1], 10) * 3600;
          const mMatch = timeStr.match(/(\d+)m/i);
          if (mMatch) seconds += parseInt(mMatch[1], 10) * 60;
          const sMatch = timeStr.match(/(\d+)s/i);
          if (sMatch) seconds += parseInt(sMatch[1], 10);
        }
      }
    }

    if (seconds !== null) {
      upgradeToTimestampLink(link, seconds);
    }
  });

  // ── 2. Find bare MM:SS or HH:MM:SS patterns in text nodes ────────
  // Only inside the summary body, not inside already-upgraded links
  const walker = document.createTreeWalker(
    summaryContent,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip text inside existing ts-link elements
        if (node.parentElement && node.parentElement.closest('.ts-link')) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip text inside anchor tags (already handled above)
        if (node.parentElement && node.parentElement.tagName === 'A') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    // Only process if contains MM:SS or HH:MM:SS pattern
    if (/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(node.textContent)) {
      textNodes.push(node);
    }
  }

  // Replace timestamp text with clickable badges
  textNodes.forEach(textNode => {
    const parent = textNode.parentNode;
    if (!parent) return;
    const parts = textNode.textContent.split(/(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/);
    if (parts.length <= 1) return; // no timestamps found

    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        // Regular text
        frag.appendChild(document.createTextNode(part));
      } else {
        // Timestamp — convert to seconds and create badge
        const seconds = timestampToSeconds(part);
        const badge = document.createElement('button');
        badge.className = 'ts-link';
        badge.setAttribute('data-seconds', String(seconds));
        badge.setAttribute('title', `Jump to ${part}`);
        badge.innerHTML = `
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          ${part}`;
        badge.addEventListener('click', (e) => {
          e.preventDefault();
          seekYouTubeTo(seconds);
        });
        frag.appendChild(badge);
      }
    });
    parent.replaceChild(frag, textNode);
  });
}

/** Converts "MM:SS" or "HH:MM:SS" to total seconds */
function timestampToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** Upgrades an existing <a> link into a timestamp badge */
function upgradeToTimestampLink(link, seconds) {
  link.classList.add('ts-link');
  link.setAttribute('data-seconds', String(seconds));
  link.setAttribute('title', `Jump to ${formatSecondsToTs(seconds)}`);
  link.removeAttribute('target');
  link.removeAttribute('rel');

  // Prepend play icon
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '9');
  icon.setAttribute('height', '9');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2.5');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', '5 3 19 12 5 21 5 3');
  icon.appendChild(poly);
  link.prepend(icon);

  link.addEventListener('click', (e) => {
    e.preventDefault();
    seekYouTubeTo(seconds);
  });
}

/** Format seconds back to MM:SS for display */
function formatSecondsToTs(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Replaces (0:00) placeholder timestamps injected by the LLM with the
 * real chapter start times provided by the API's topics array.
 * Matches badges sequentially to topics by position order.
 *
 * Called after showResult() + makeTimestampsClickable() so ts-link
 * buttons already exist in the DOM.
 */
function injectTopicTimestamps(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return;

  // Collect all ts-link elements with data-seconds="0" (placeholder badges)
  const zeroBadges = Array.from(
    summaryContent.querySelectorAll('.ts-link[data-seconds="0"]')
  );

  let topicIndex = 0;

  zeroBadges.forEach(badge => {
    if (topicIndex >= topics.length) return;
    const topic = topics[topicIndex++];
    const seconds = Math.floor((topic.startMs || 0) / 1000);

    // Preserve a non-zero time even if the topic's startMs is genuinely 0
    // (intro chapter) — at least remove the hallucinated value
    const label = formatSecondsToTs(seconds);

    badge.setAttribute('data-seconds', String(seconds));
    badge.setAttribute('title', `Jump to ${label}`);

    // Re-render the badge text (keep the SVG play icon, update time text)
    const existingSvg = badge.querySelector('svg');
    // Clear and rebuild
    badge.innerHTML = '';
    if (existingSvg) badge.appendChild(existingSvg);
    badge.appendChild(document.createTextNode(' ' + label));

    // Re-bind seek handler with corrected seconds value
    badge.onclick = null;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      seekYouTubeTo(seconds);
    });
  });

  // Edge-case: if makeTimestampsClickable hasn't run yet (rare),
  // there may still be raw "(0:00)" text nodes — leave them;
  // they'll be picked up by the TreeWalker in makeTimestampsClickable
  // which runs before this function is called.
}

// ── Seek YouTube player via chrome.scripting.executeScript ───────────
function seekYouTubeTo(seconds) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) {
      showToast('No active tab found', 'error');
      return;
    }

    // Make sure we're on a YouTube tab
    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      showToast('Open a YouTube video first', 'error');
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        func: (s) => {
          // YouTube uses the <video> element for playback
          const video = document.querySelector('video');
          if (!video) return { ok: false, reason: 'no_video' };
          video.currentTime = s;
          // Also trigger play if it was paused
          if (video.paused) video.play().catch(() => {});
          return { ok: true, seekedTo: s };
        },
        args: [seconds],
      },
      (results) => {
        if (chrome.runtime.lastError) {
          showToast('Could not access page', 'error');
          return;
        }
        const result = results?.[0]?.result;
        if (result?.ok) {
          showToast(`⏩ Jumped to ${formatSecondsToTs(seconds)}`, 'success');
        } else if (result?.reason === 'no_video') {
          showToast('Video player not found on page', 'error');
        }
      }
    );
  });
}

// ══════════════════════════════════════════════════════════════════════
// ── STEP 4 CORE: Summarize Button → fetch() → API → render ──────────
// ══════════════════════════════════════════════════════════════════════
summarizeBtn.addEventListener('click', async () => {
  if (!currentVideoUrl) return;

  const model    = modelSelect.value || 'glm-4.7-flash';
  const language = langSelect.value  || 'en';

  showLoading('Connecting to YT Summarizer API...');

  try {
    // ── Make the streaming POST request ─────────────────────────────
    // credentials: 'include' sends the better-auth session cookie
    const response = await fetch(`${API_BASE}/api/summarize`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentVideoUrl,
        detailLevel: 3,
        language,
        model,
      }),
    });

    // ── 401 — not logged in ──────────────────────────────────────────
    if (response.status === 401) {
      showError(
        'Not Signed In',
        `Please open ${API_BASE} in your browser, sign in, then try again.`
      );
      return;
    }

    // ── 429 — rate limit / insufficient balance ──────────────────────
    if (response.status === 429) {
      showError(
        '⚠️ API Limit Reached',
        'Too many requests or insufficient API credits. Please check your balance and try again.'
      );
      return;
    }

    if (!response.ok) {
      showError('API Error', `Server returned ${response.status}. API is on: ${API_BASE}`);
      return;
    }

    // ── Guard: response.body must be readable ────────────────────────
    if (!response.body) {
      showError('Stream Error', 'The API did not return a streaming response. Is the server running correctly?');
      return;
    }

    // ── Stream the newline-delimited JSON response ───────────────────
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let streamingMarkdown = '';
    let isStreaming = false;
    let renderPending = false;

    // Throttled renderer: avoids thrashing the DOM on every tiny chunk
    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        // Render with a blinking cursor appended so user sees live typing
        summaryContent.innerHTML = markdownToHtml(streamingMarkdown) +
          '<span class="sp-stream-cursor"></span>';
      });
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line; default to ''

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event;
          try { event = JSON.parse(trimmed); }
          catch { continue; }  // skip non-JSON lines

          if (!event || typeof event.type !== 'string') continue;

          if (event.type === 'progress') {
            const stageLabels = {
              fetching_transcript: '📄 Fetching video transcript...',
              analyzing_topics:    '🔍 Analyzing content structure...',
              generating_summary:  '✨ Generating AI summary...',
              building_timeline:   '⏱️ Building chapter timeline...',
            };
            const label = stageLabels[event.stage] || event.message || 'Processing...';
            if (loadingSub) loadingSub.textContent = label;

          } else if (event.type === 'stream_chunk') {
            // First chunk: transition loading spinner → result panel
            if (!isStreaming) {
              isStreaming = true;
              loadingState.style.display  = 'none';
              errorState.style.display    = 'none';
              resultSection.style.display = 'block';
              // Keep button in "Generating..." state while chunks are arriving
              btnContent.innerHTML = `<div class="sp-btn-spinner"></div><span>Generating...</span>`;
              summarizeBtn.disabled = true;
              statusBadge.className = 'sp-header-badge loading';
              badgeLabel.textContent = 'Streaming...';
            }

            // Append chunk and schedule a throttled DOM render
            streamingMarkdown += event.chunk || '';
            scheduleRender();

          } else if (event.type === 'complete') {
            // Use the authoritative content from the server (may differ from streamed chunks)
            const summary  = event.summary || {};
            const topics   = Array.isArray(summary.topics) ? summary.topics : [];
            const finalContent = (typeof summary.content === 'string' && summary.content)
              ? summary.content
              : streamingMarkdown;
            const finalHtml = markdownToHtml(finalContent);

            // Always transition to result panel — handles both streamed AND cached (English)
            // responses where no stream_chunk events arrived.
            loadingState.style.display  = 'none';
            errorState.style.display    = 'none';
            resultSection.style.display = 'block';

            showResult(finalHtml);  // sets status → ready, re-enables button, makeTimestampsClickable

            // ── Inject real timestamps from API topics ──────────────────
            if (topics.length > 0) {
              injectTopicTimestamps(topics);
            }

            // ── Enable Chat tab for this video ──────────────────────────
            if (summary.videoId) {
              initChat(summary.videoId);
            }

            chrome.storage.local.set({
              lastSummary: { html: summaryContent.innerHTML, url: currentVideoUrl, timestamp: Date.now() },
            });

          } else if (event.type === 'error') {
            const msg = (event.error || 'An error occurred').toString();
            if (
              msg.toLowerCase().includes('429') ||
              msg.toLowerCase().includes('balance') ||
              msg.toLowerCase().includes('credits') ||
              msg.toLowerCase().includes('quota') ||
              msg.toLowerCase().includes('rate limit')
            ) {
              showError('⚠️ API Credits Exhausted', 'Your API balance is insufficient. Please top up your credits.');
            } else if (
              msg.toLowerCase().includes('transcript') ||
              msg.toLowerCase().includes('caption') ||
              msg.toLowerCase().includes('no transcript')
            ) {
              showError(
                '📄 No Transcript Available',
                'This video has no captions or subtitles. Try a video that has auto-generated or manual captions enabled.'
              );
            } else {
              showError('Summary Failed', msg);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

  } catch (err) {
    console.error('[YT Summarizer] fetch error:', err);
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showError(
        'Cannot Reach API',
        'Make sure your Next.js server is running: open a terminal and run "npm run dev" in your project folder.'
      );
    } else {
      showError('Unexpected Error', err.message || 'Something went wrong. Please try again.');
    }
  }
});

// ── Message listener — background.js sends YouTube URL or non-YouTube event ──
const notYtState  = document.getElementById('not-yt-state');
const mainCard    = document.querySelector('.sp-card');

function showNotYouTube() {
  if (notYtState) notYtState.style.display = 'flex';
  if (mainCard)   mainCard.style.display    = 'none';
  loadingState.style.display  = 'none';
  errorState.style.display    = 'none';
  resultSection.style.display = 'none';
}

function restoreFromNotYouTube() {
  if (notYtState) notYtState.style.display = 'none';
  if (mainCard)   mainCard.style.display    = '';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'YOUTUBE_URL_DETECTED' && message.url) {
    restoreFromNotYouTube();
    const url = message.url;
    // Only trigger UI reset if diving into a legitimately new distinct video URL
    if (currentVideoUrl !== url) {
      currentVideoUrl = url;
      urlInput.value  = url;
      urlClear.style.display   = 'flex';
      setUrlValid(true);
      detectBanner.style.display = 'flex';
      const displayUrl = url.length > 45 ? url.slice(0, 42) + '…' : url;
      detectText.textContent = `Detected: ${displayUrl}`;

      // Immediately wipe previous summary state out to prevent confusion
      resultSection.style.display = 'none';
      summaryContent.innerHTML = '';
      setStatus('ready');
      chrome.storage.local.remove(['lastSummary']);

      console.log('[YT Summarizer] URL received and UI reset for new video:', url);
    }
  } else if (message.type === 'NOT_YOUTUBE_TAB') {
    showNotYouTube();
  }
});

// ── On load: detect API port, then restore state ───────────────────
detectApiPort(); // runs async in background

chrome.storage.local.get(['lastYouTubeUrl', 'lastSummary'], (result) => {
  if (result.lastYouTubeUrl && isYouTubeUrl(result.lastYouTubeUrl)) {
    urlInput.value = result.lastYouTubeUrl;
    urlClear.style.display = 'flex';
    currentVideoUrl = result.lastYouTubeUrl;
    setUrlValid(true);
  }
  // Optionally restore the last summary only if it directly matches the currently opened video
  if (
    result.lastSummary && 
    result.lastSummary.url === currentVideoUrl &&
    Date.now() - result.lastSummary.timestamp < 10 * 60 * 1000
  ) {
    showResult(result.lastSummary.html);
  }
});

// ── Theme Toggle Setup ───────────────────────────────────────────────
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('brieflytube-theme', next);
  });
}

// ══════════════════════════════════════════════════════════════════════
// ── CHAT SYSTEM (Phase 4 — RAG) ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// ── DOM refs ─────────────────────────────────────────────────────────
const tabSummaryBtn  = document.getElementById('tab-summary');
const tabChatBtn     = document.getElementById('tab-chat');
const summaryPanel   = document.getElementById('summary-panel');
const chatPanel      = document.getElementById('chat-panel');
const chatMessages   = document.getElementById('chat-messages');
const chatInput      = document.getElementById('chat-input');
const chatSendBtn    = document.getElementById('chat-send-btn');

// ── State ─────────────────────────────────────────────────────────────
let chatVideoId     = null;    // set when a summary completes
let chatBusy        = false;   // prevents concurrent requests

// ── Tab switching ─────────────────────────────────────────────────────
function switchToTab(tab) {
  const isSummary = tab === 'summary';
  tabSummaryBtn.classList.toggle('sp-tab--active', isSummary);
  tabChatBtn.classList.toggle('sp-tab--active', !isSummary);
  summaryPanel.style.display = isSummary ? '' : 'none';
  chatPanel.style.display    = isSummary ? 'none' : 'flex';
  if (!isSummary) {
    chatInput.focus();
    scrollChatToBottom();
  }
}

tabSummaryBtn.addEventListener('click', () => switchToTab('summary'));
tabChatBtn.addEventListener('click',    () => switchToTab('chat'));

// ── Initialise chat for a video ───────────────────────────────────────
function initChat(videoId) {
  chatVideoId = videoId;
  tabChatBtn.disabled = false;

  // Show intro only when the messages area is empty (fresh video)
  if (chatMessages.children.length === 0) {
    chatMessages.innerHTML = `
      <div class="sp-chat-intro">
        <div class="sp-chat-intro-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <p><strong>Chat about this video</strong></p>
        <p>Ask me anything &#8212; what it covers, key points, specific details&#8230;</p>
      </div>`;
  }
}


// ── Scroll chat to bottom ─────────────────────────────────────────────
function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Append a message bubble ───────────────────────────────────────────
function appendMessage(role, text) {
  // Remove intro card if present
  const intro = chatMessages.querySelector('.sp-chat-intro');
  if (intro) intro.remove();

  const wrap = document.createElement('div');
  wrap.className = `sp-chat-msg sp-chat-msg--${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'sp-chat-bubble';
  bubble.textContent = text || '';
  wrap.appendChild(bubble);

  chatMessages.appendChild(wrap);
  scrollChatToBottom();
  return bubble;  // returned so streaming can update it in-place
}

// ── Send a chat message ───────────────────────────────────────────────
async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !chatVideoId || chatBusy) return;

  chatBusy = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatSendBtn.disabled = true;

  // Render user bubble
  appendMessage('user', text);

  // Render thinking AI bubble with cursor
  const aiBubble = appendMessage('ai', '');
  aiBubble.innerHTML = '<span class="sp-chat-cursor"></span>';
  const aiWrap = aiBubble.parentElement;
  aiWrap.classList.add('sp-chat-msg--thinking');

  let fullText = '';

  try {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, videoId: chatVideoId }),
    });

    if (resp.status === 401) {
      aiBubble.textContent = '⚠️ Not signed in. Open the dashboard and log in first.';
      aiWrap.classList.remove('sp-chat-msg--thinking');
      return;
    }
    if (!resp.ok) {
      aiBubble.textContent = `⚠️ Server error (${resp.status}). Please try again.`;
      aiWrap.classList.remove('sp-chat-msg--thinking');
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try { ev = JSON.parse(trimmed); } catch { continue; }

        if (ev.type === 'chunk') {
          fullText += ev.text || '';
          aiWrap.classList.remove('sp-chat-msg--thinking');
          aiBubble.innerHTML = escapeHtml(fullText) + '<span class="sp-chat-cursor"></span>';
          scrollChatToBottom();
        } else if (ev.type === 'done') {
          aiBubble.textContent = fullText || '(no response)';
        } else if (ev.type === 'error') {
          aiBubble.textContent = `⚠️ ${ev.error || 'Something went wrong.'}`;
        }
      }
    }

    reader.releaseLock();

    // Finalize — remove cursor
    if (!aiBubble.querySelector('.sp-chat-cursor') === false) {
      aiBubble.textContent = fullText || '(no response)';
    }
  } catch (err) {
    console.error('[Chat] fetch error:', err);
    aiBubble.textContent = '⚠️ Could not reach the server. Is it running?';
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatInput.focus();
    scrollChatToBottom();
  }
}

// ── Simple HTML escaper (prevents XSS in bubbles) ─────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Send button + Enter key ───────────────────────────────────────────
chatSendBtn.addEventListener('click', sendChatMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Auto-grow textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
});

// Chat tab starts disabled until a summary loads
if (tabChatBtn) tabChatBtn.disabled = true;
