import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { orNull, type Llm } from "../llm/llm.js";
import { readLlmCache, writeLlmCache } from "../llm/routed.js";
import type { Question } from "./bank.js";
import { MAX_LLM_OPTIONS, similarity, trigrams } from "./rank.js";

/** Saved questions shown to the LLM per new question (the most similar ones). */
const PREFILTER_LIMIT = 20;
/** Other wordings shown per saved question. */
const MAX_WORDINGS = 5;

const Confidence = z.enum(["high", "medium", "low"]);
const BatchSchema = z.object({
  matches: z.array(z.object({ key: z.string(), matchId: z.number().int().nullable(), confidence: Confidence })),
});
const CachedSchema = z.object({ matchId: z.number().int().nullable(), confidence: Confidence });
type Out = z.infer<typeof CachedSchema>;

const MATCH_SYSTEM = `You decide whether questions on a job application form are the same questions as ones already saved in an applicant's answer bank, so the saved answers can be reused.

You receive the new questions (each with a key, whether it is factual, and the ids of the saved questions it may match) and the saved questions with their ids and the other wordings they have appeared under. "{company}" stands for whichever company the applicant is applying to.

For every new question, return its key and the id of the saved question (from its candidate ids) that asks for the same information, or null if none does. Same meaning is required, not the same topic: "Are you authorized to work in the US?" and "Will you require visa sponsorship?" are different questions, as are "Do you require sponsorship now?" and "Will you require sponsorship now or in the future?".

For factual questions (work authorization, sponsorship, citizenship, dates, GPA, demographics, prior employment, and similar), a match must ask for exactly the same fact, with the same polarity and scope, so that the saved answer is correct for the new question without any change. If you are not sure, return null.

confidence: "high" when the saved answer would certainly be correct for the new question, "medium" when it very likely would, "low" otherwise.`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9{}]+/g, " ").trim();

/**
 * A factual question is only matched to a saved one whose wording shares at least this much with it (trigram
 * similarity of the new question or its label against the saved wordings). A backstop for models that "match" a
 * different fact: a local model matched an export-sanctions question (0.14) to work authorization; paraphrases of the
 * same fact ("Do you need a visa to work here?" / "Will you now or in the future require visa sponsorship?") score 0.18+.
 */
const FACTUAL_MIN_SIMILARITY = 0.16;

/** Labels shorter than this ("Please explain", "Other") say too little to match on wording alone. */
const MIN_SHORTCUT_WORDS = 4;

export interface MatchItem {
  /** The caller's key for this question (e.g. the field id). */
  key: string;
  canonical: string;
  isFactual: boolean;
  /** The field's label: with at least four words, an identical saved wording matches without the LLM. */
  label?: string;
}

/** The bank's revision: it changes whenever a question or wording is added, edited or removed (see the migration). */
function bankRevision(db: Db): number {
  return (db.prepare("SELECT rev FROM bank_revision WHERE id = 1").get() as { rev: number } | undefined)?.rev ?? 0;
}

const cacheKey = (canonical: string, isFactual: boolean, rev: number) =>
  `match:${createHash("sha1").update(`${norm(canonical)}|${isFactual ? 1 : 0}|${rev}`).digest("hex")}`;

/** How much of the saved question's wordings the new question (or its label) shares. */
const wordingSimilarity = (item: MatchItem, q: Question) => {
  const mine = [item.canonical, item.label ?? ""].filter(Boolean).map(trigrams);
  return Math.max(0, ...[q.canonical, ...q.variants].map(t => trigrams(t)).flatMap(t => mine.map(m => similarity(m, t))));
};

const accepted = (out: Out, shortlist: Question[], item: MatchItem): number | null => {
  const q = out.matchId === null ? undefined : shortlist.find(x => x.id === out.matchId);
  if (!q) return null;
  if (item.isFactual && wordingSimilarity(item, q) < FACTUAL_MIN_SIMILARITY) return null;
  return out.confidence === "high" || (out.confidence === "medium" && !item.isFactual) ? q.id : null;
};

/**
 * Finds, for every item, the saved question with the same meaning (or null). An item whose label has at least four
 * words matches a saved question with the same canonical text (ignoring case and punctuation) without the LLM. The
 * rest go to the LLM in ONE request, each with the 20 saved questions most similar to it; it accepts a high-confidence
 * match, or a medium one for non-factual questions. Results are cached per (canonical, bank revision), so the same
 * question against an unchanged bank costs nothing. When the AI is unavailable, unmatched items stay null.
 */
export async function matchQuestions(db: Db, llm: Llm, items: MatchItem[], candidates: Question[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>(items.map(i => [i.key, null]));
  if (!candidates.length || !items.length) return result;
  const rev = bankRevision(db);
  const ask: { item: MatchItem; shortlist: Question[]; cache: string }[] = [];

  for (const item of items) {
    const want = norm(item.canonical);
    if (want && item.label !== undefined && norm(item.label).split(" ").filter(Boolean).length >= MIN_SHORTCUT_WORDS) {
      const exact = candidates.find(q => norm(q.canonical) === want);
      if (exact) { result.set(item.key, exact.id); continue; }
    }
    const target = trigrams(item.canonical);
    const shortlist = candidates
      .map((q, i) => ({ q, i, score: Math.max(...[q.canonical, ...q.variants].map(t => similarity(target, trigrams(t)))) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, PREFILTER_LIMIT)
      .map(x => x.q);
    const key = cacheKey(item.canonical, item.isFactual, rev);
    const hit = CachedSchema.safeParse(readLlmCache(db, key));
    if (hit.success) { result.set(item.key, accepted(hit.data, shortlist, item)); continue; }
    ask.push({ item, shortlist, cache: key });
  }
  if (!ask.length) return result;

  const saved = new Map<number, Question>();
  for (const a of ask) for (const q of a.shortlist) saved.set(q.id, q);
  const keyOf = (i: number) => `q${i + 1}`;
  const out = await orNull(llm.structured({
    name: "match",
    schema: BatchSchema,
    system: MATCH_SYSTEM,
    effort: "low",
    content: JSON.stringify({
      newQuestions: ask.map((a, i) => ({ key: keyOf(i), question: a.item.canonical, isFactual: a.item.isFactual, candidateIds: a.shortlist.map(q => q.id) })),
      savedQuestions: [...saved.values()].map(q => ({
        id: q.id, question: q.canonical, otherWordings: q.variants.slice(0, MAX_WORDINGS), options: q.options?.slice(0, MAX_LLM_OPTIONS) ?? null,
      })),
    }),
  }));
  if (!out) return result;

  const byKey = new Map(out.matches.map(m => [m.key, m]));
  ask.forEach((a, i) => {
    const m = byKey.get(keyOf(i));
    if (!m) return;
    const raw: Out = { matchId: m.matchId, confidence: m.confidence };
    writeLlmCache(db, a.cache, "match", raw);
    result.set(a.item.key, accepted(raw, a.shortlist, a.item));
  });
  return result;
}

/** One question's match (see matchQuestions). */
export async function matchQuestion(db: Db, llm: Llm, canonical: string, isFactual: boolean, candidates: Question[], label?: string): Promise<number | null> {
  return (await matchQuestions(db, llm, [{ key: "q", canonical, isFactual, label }], candidates)).get("q") ?? null;
}
