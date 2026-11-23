/** Task identifiers look like `APO-12` (project key + number). Returns unique `{key, number}` pairs found in free text. */
export function extractTaskKeys(...texts: Array<string | null | undefined>): Array<{ key: string; number: number }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; number: number }> = [];
  for (const t of texts) {
    if (!t) continue;
    // branch names are usually lower-case (`feature/apo-12-login`), so match case-insensitively but normalise the key
    for (const m of t.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g)) {
      const key = m[1]!.toUpperCase();
      const number = Number(m[2]);
      const id = `${key}-${number}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ key, number });
      }
    }
  }
  return out.slice(0, 20);
}
