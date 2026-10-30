/** No LLM request ever carries more than this many options of one field. */
export const MAX_LLM_OPTIONS = 30;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9{}]+/g, " ").trim();

/** Trigrams of each word, padded at the word's edges (as in pg_trgm), so "authorized" and "authorization" overlap. */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of norm(text).split(" ").filter(Boolean)) {
    const w = `  ${word} `;
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

const shared = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
};

/** Jaccard similarity of two trigram sets. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const n = shared(a, b);
  return n / (a.size + b.size - n);
}

/**
 * How well `option` fits `target`: trigram similarity, plus how much of the option appears in the target (so a short
 * option inside a long value, or a long value's words in a long option, still rank high), plus whole-word overlap.
 */
function score(target: Set<string>, targetWords: Set<string>, option: string): number {
  const t = trigrams(option);
  if (!t.size) return 0;
  const words = norm(option).split(" ").filter(w => w.length > 1);
  const wordHits = words.length ? words.filter(w => targetWords.has(w)).length / words.length : 0;
  return similarity(target, t) + 0.5 * (shared(target, t) / t.size) + 0.5 * wordHits;
}

/**
 * At most `limit` of `options`, the ones closest to `target` (one text, or several: the best of them counts), kept in
 * the list's own order. A list already short enough is returned as is.
 */
export function topOptions(target: string | string[], options: string[], limit = MAX_LLM_OPTIONS): string[] {
  if (options.length <= limit) return options;
  const targets = (Array.isArray(target) ? target : [target]).filter(t => t.trim());
  const sets = targets.map(t => ({ tri: trigrams(t), words: new Set(norm(t).split(" ").filter(Boolean)) }));
  const exact = new Set(targets.map(norm));
  const ranked = options
    .map((o, i) => ({ i, s: exact.has(norm(o)) ? 10 : Math.max(0, ...sets.map(x => score(x.tri, x.words, o))) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map(x => x.i)
    .sort((a, b) => a - b);
  return ranked.map(i => options[i]!);
}
