export interface Chunk {
  index: number;
  heading: string | null;
  content: string;
}

export interface ChunkOptions {
  /** Target size in characters (≈4 chars/token). */
  maxChars?: number;
  overlapChars?: number;
}

/**
 * Splits normalised text into overlapping chunks, preferring heading and paragraph boundaries.
 * Each chunk remembers the nearest preceding heading for citations.
 */
export function chunkText(text: string, { maxChars = 1200, overlapChars = 150 }: ChunkOptions = {}): Chunk[] {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let buf = '';
  let bufHeading: string | null = null;
  let headingOnly = false;

  const flush = () => {
    const content = buf.trim();
    if (content) chunks.push({ index: chunks.length, heading: bufHeading, content });
    buf = '';
    headingOnly = false;
  };

  for (const block of blocks) {
    const h = /^#{1,6}\s+(.*)$/.exec(block);
    if (h) {
      // A heading starts a new chunk and is ALSO searchable text (a document that is only headings must still be indexed).
      // Consecutive headings with no body between them collapse into one chunk instead of leaving empty stubs.
      if (!headingOnly) flush();
      heading = h[1]!.trim();
      bufHeading = heading;
      buf = buf ? `${buf}\n\n${heading}` : heading;
      headingOnly = true;
      continue;
    }
    headingOnly = false;
    // A single block bigger than the budget is split on sentence/space boundaries.
    const pieces = block.length <= maxChars ? [block] : splitLong(block, maxChars);
    for (const piece of pieces) {
      if (buf && buf.length + piece.length + 2 > maxChars) {
        const tail = buf.slice(-overlapChars);
        flush();
        buf = overlapChars > 0 ? tail.slice(tail.indexOf(' ') + 1) + ' ' : '';
      }
      if (!buf) bufHeading = heading;
      buf += (buf && !buf.endsWith(' ') ? '\n\n' : '') + piece;
    }
  }
  flush();
  return chunks;
}

function splitLong(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf(' ', max));
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Strips HTML (Tiptap output) to plain text with headings kept as `# ` lines so the chunker can use them. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l: string, t: string) => `\n\n${'#'.repeat(Number(l))} ${t}\n\n`)
    .replace(/<\/(p|div|li|blockquote|pre|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
