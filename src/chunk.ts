// Turning a published pqdoctor.com docs page (Starlight HTML) into one chunk per section.
// Plain TypeScript with no imports, so both the Worker tests and `node scripts/reindex.ts`
// (Node's built-in type stripping) can use it.

export interface DocChunk {
  /** Stable id: page path + section anchor + part number. */
  id: string;
  page: string;
  section: string;
  /** Link to the section on pqdoctor.com. */
  url: string;
  /** "Page: Section" followed by the section's text; the title travels with the chunk. */
  text: string;
}

/** Sections longer than this are split at paragraph breaks (the embedding model reads ~512 tokens). */
export const MAX_CHUNK_CHARS = 1600;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←", times: "×", middot: "·" };

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** HTML fragment to readable text: paragraphs, list items, table rows and code lines on their own lines. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|svg|button|template)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\b[^>]*class="[^"]*sl-anchor-link[^"]*"[\s\S]*?<\/a>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/tr>/gi, "@@ROW@@")
      .replace(/<\/(p|li|h[1-6]|pre|div|blockquote|figcaption|dt|dd)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ \|\n+(?=[^\n])/g, " | ") // keep a table row's cells on one line
    .replace(/\s*\|?\s*@@ROW@@\s*/g, "\n") // one row per line
    .replace(/ \| *(?=\n|$)/g, "")
    .replace(/^Terminal window\n?/gm, "") // the label on code-block frames
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function idFor(path: string, anchor: string, part: number): string {
  const base = `${path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-")}#${anchor}`;
  return `${base.slice(0, 58)}~${part}`; // Vectorize ids are at most 64 bytes
}

/**
 * Split one page into section chunks. `path` is the page's path on pqdoctor.com ("/pqdoctor/how-it-works/").
 * Content before the first h2 becomes an "Overview" chunk. Long sections are split at paragraph
 * breaks; every part keeps "Page: Section" at the top.
 */
export function chunkPage(html: string, path: string, origin = "https://pqdoctor.com"): DocChunk[] {
  const title = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? path).replace(/<[^>]+>/g, "")).trim();
  // The page's one-line summary goes under every section's title line, so a section like
  // "tls12-only: Overview" still says what the page is about (better retrieval, better answers).
  const description = decode(/<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? "").trim();
  // The content div, not the first mention of the class (Starlight's inline CSS names it too).
  const start = html.search(/<div\b[^>]*class="[^"]*\bsl-markdown-content\b/);
  if (start < 0) return [];
  const bodyStart = html.indexOf(">", start) + 1;
  const footer = html.indexOf("<footer", bodyStart);
  const body = html.slice(bodyStart, footer > 0 ? footer : undefined);

  // Cut at every h2: [before-first-h2, (h2, content), (h2, content), ...]
  const parts = body.split(/(<h2\b[^>]*>[\s\S]*?<\/h2>)/i);
  const sections: Array<{ anchor: string; heading: string; html: string }> = [{ anchor: "_top", heading: "Overview", html: parts[0] }];
  for (let i = 1; i < parts.length; i += 2) {
    const anchor = /id="([^"]+)"/.exec(parts[i])?.[1] ?? `section-${i}`;
    const heading = decode(parts[i].replace(/<[^>]+>/g, "")).trim();
    sections.push({ anchor, heading, html: parts[i + 1] ?? "" });
  }

  const chunks: DocChunk[] = [];
  for (const s of sections) {
    const text = htmlToText(s.html);
    if (text.length < 40) continue; // empty intro or a heading with nothing under it
    const label = `${title}: ${s.heading}`;
    const pieces: string[] = [];
    let cur = "";
    for (const para of text.split(/\n\n+/)) {
      if (cur && cur.length + para.length + 2 > MAX_CHUNK_CHARS) {
        pieces.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${para}` : para;
      while (cur.length > MAX_CHUNK_CHARS) {
        pieces.push(cur.slice(0, MAX_CHUNK_CHARS));
        cur = cur.slice(MAX_CHUNK_CHARS);
      }
    }
    if (cur) pieces.push(cur);
    pieces.forEach((p, n) => {
      chunks.push({
        id: idFor(path, s.anchor, n),
        page: title,
        section: s.heading,
        url: `${origin}${path}${s.anchor === "_top" ? "" : `#${s.anchor}`}`,
        text: description ? `${label}\n(${description})\n${p}` : `${label}\n${p}`,
      });
    });
  }
  return chunks;
}
