interface Topic {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  order: number;
}

interface Summary {
  title: string;
  content: string;
}

const PDF_PAGE_WIDTH = 595;
const PDF_PAGE_HEIGHT = 842;
const PDF_MARGIN = 48;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
const PDF_TITLE_FONT_SIZE = 20;
const PDF_BODY_FONT_SIZE = 11;
const PDF_LINE_HEIGHT = 16;

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function generateYouTubeLink(videoId: string, startMs: number): string {
  const seconds = Math.floor(startMs / 1000);
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function convertMarkdownToHtml(markdown: string): string {
  const escaped = escapeHtml(markdown).replace(/\r\n/g, "\n");

  return escaped
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br />");
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^- /gm, "• ")
    .trim();
}

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.52;
}

function wrapPdfText(text: string, fontSize: number, maxWidth: number): string[] {
  const normalized = text.replace(/\t/g, "  ").trim();
  if (!normalized) {
    return [""];
  }

  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (!currentLine || estimateTextWidth(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function buildPdfLines(summary: Summary, topics: Topic[], videoId: string): Array<{
  text: string;
  fontSize: number;
}> {
  const lines: Array<{ text: string; fontSize: number }> = [
    { text: summary.title, fontSize: PDF_TITLE_FONT_SIZE },
    { text: "", fontSize: PDF_BODY_FONT_SIZE },
    {
      text: `Video: https://www.youtube.com/watch?v=${videoId}`,
      fontSize: PDF_BODY_FONT_SIZE,
    },
  ];

  if (topics.length > 0) {
    lines.push({ text: "", fontSize: PDF_BODY_FONT_SIZE });
    lines.push({ text: "Chapters", fontSize: 14 });

    const sortedTopics = [...topics].sort((a, b) => a.order - b.order);
    for (const topic of sortedTopics) {
      lines.push({
        text: `• ${formatTime(topic.startMs)} - ${topic.title}`,
        fontSize: PDF_BODY_FONT_SIZE,
      });
    }
  }

  lines.push({ text: "", fontSize: PDF_BODY_FONT_SIZE });
  lines.push({ text: "Summary", fontSize: 14 });

  const plainSummary = stripMarkdown(summary.content);
  for (const paragraph of plainSummary.split(/\n{2,}/)) {
    if (!paragraph.trim()) {
      lines.push({ text: "", fontSize: PDF_BODY_FONT_SIZE });
      continue;
    }

    for (const rawLine of paragraph.split("\n")) {
      lines.push({ text: rawLine.trim(), fontSize: PDF_BODY_FONT_SIZE });
    }
    lines.push({ text: "", fontSize: PDF_BODY_FONT_SIZE });
  }

  lines.push({ text: "Generated with YouTube Summarizer", fontSize: 10 });

  return lines;
}

function buildPdfPages(summary: Summary, topics: Topic[], videoId: string): string[] {
  const pages: string[] = [];
  let operations: string[] = [];
  const lines = buildPdfLines(summary, topics, videoId);
  let cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;

  for (const entry of lines) {
    const fontSize = entry.fontSize;
    const wrappedLines =
      entry.text === ""
        ? [""]
        : wrapPdfText(entry.text, fontSize, PDF_CONTENT_WIDTH);

    for (const line of wrappedLines) {
      if (cursorY < PDF_MARGIN) {
        pages.push(operations.join("\n"));
        operations = [];
        cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
      }

      if (line) {
        operations.push("BT");
        operations.push(`/F1 ${fontSize} Tf`);
        operations.push(`${PDF_MARGIN} ${cursorY} Td`);
        operations.push(`(${escapePdfText(line)}) Tj`);
        operations.push("ET");
      }

      cursorY -= fontSize === PDF_TITLE_FONT_SIZE ? PDF_LINE_HEIGHT + 6 : PDF_LINE_HEIGHT;
    }
  }

  if (operations.length > 0) {
    pages.push(operations.join("\n"));
  }

  return pages.length > 0 ? pages : [""];
}

function createPdfBlob(summary: Summary, topics: Topic[], videoId: string): Blob {
  const pageStreams = buildPdfPages(summary, topics, videoId);
  const objects: string[] = [];

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");

  const pageObjectNumbers: number[] = [];
  const contentObjectNumbers: number[] = [];

  for (let index = 0; index < pageStreams.length; index++) {
    pageObjectNumbers.push(3 + index * 2);
    contentObjectNumbers.push(4 + index * 2);
  }

  const kidsRefs = pageObjectNumbers.map((pageNumber) => `${pageNumber} 0 R`).join(" ");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${pageStreams.length} >>\nendobj`
  );

  for (let index = 0; index < pageStreams.length; index++) {
    const pageObjectNumber = pageObjectNumbers[index];
    const contentObjectNumber = contentObjectNumbers[index];
    const stream = pageStreams[index];
    const streamLength = new TextEncoder().encode(stream).length;

    objects.push(
      `${pageObjectNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 ${3 + pageStreams.length * 2} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>\nendobj`
    );
    objects.push(
      `${contentObjectNumber} 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj`
    );
  }

  objects.push(
    `${3 + pageStreams.length * 2} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += `${object}\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Blob([pdf], { type: "application/pdf" });
}

function buildDocumentHtml(
  summary: Summary,
  topics: Topic[],
  videoId: string,
  includePrintStyles = false
): string {
  const sortedTopics = [...topics].sort((a, b) => a.order - b.order);
  const topicItems = sortedTopics
    .map((topic) => {
      const timestamp = formatTime(topic.startMs);
      const link = generateYouTubeLink(videoId, topic.startMs);
      return `<li><a href="${link}">${timestamp}</a> - ${escapeHtml(topic.title)}</li>`;
    })
    .join("");

  const printStyles = includePrintStyles
    ? `
      @page { margin: 18mm; }
      @media print {
        body { margin: 0; }
      }
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(summary.title)}</title>
    <style>
      body {
        font-family: "Georgia", "Times New Roman", serif;
        color: #1e293b;
        line-height: 1.6;
        margin: 0;
        background: #ffffff;
      }
      .document {
        max-width: 800px;
        margin: 0 auto;
        padding: 40px 32px 56px;
      }
      h1, h2, h3 {
        color: #0f172a;
        line-height: 1.25;
        margin-top: 1.4em;
        margin-bottom: 0.6em;
      }
      h1 {
        font-size: 30px;
        margin-top: 0;
      }
      h2 {
        font-size: 22px;
      }
      h3 {
        font-size: 18px;
      }
      p {
        margin: 0 0 1em;
      }
      .meta {
        margin-bottom: 24px;
        padding: 16px 18px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
      }
      .section {
        margin-top: 28px;
      }
      ul {
        padding-left: 24px;
        margin: 0 0 1em;
      }
      li {
        margin-bottom: 8px;
      }
      a {
        color: #2563eb;
        text-decoration: none;
      }
      strong {
        color: #0f172a;
      }
      .summary-content p:first-child {
        margin-top: 0;
      }
      .footer {
        margin-top: 36px;
        padding-top: 18px;
        border-top: 1px solid #e2e8f0;
        color: #64748b;
        font-size: 13px;
      }
      ${printStyles}
    </style>
  </head>
  <body>
    <main class="document">
      <h1>${escapeHtml(summary.title)}</h1>

      <section class="meta">
        <p><strong>Video:</strong> <a href="https://www.youtube.com/watch?v=${videoId}">Watch on YouTube</a></p>
      </section>

      ${
        topicItems
          ? `<section class="section">
        <h2>Chapters</h2>
        <ul>${topicItems}</ul>
      </section>`
          : ""
      }

      <section class="section summary-content">
        <h2>Summary</h2>
        <p>${convertMarkdownToHtml(summary.content)}</p>
      </section>

      <footer class="footer">Generated with YouTube Summarizer</footer>
    </main>
  </body>
</html>`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportSummaryAsWord(
  summary: Summary,
  topics: Topic[],
  videoId: string
): void {
  const html = buildDocumentHtml(summary, topics, videoId);
  const blob = new Blob([html], {
    type: "application/msword;charset=utf-8",
  });

  triggerDownload(blob, `${videoId}-summary.doc`);
}

export function exportSummaryAsPdf(
  summary: Summary,
  topics: Topic[],
  videoId: string
): void {
  const blob = createPdfBlob(summary, topics, videoId);
  triggerDownload(blob, `${videoId}-summary.pdf`);
}
