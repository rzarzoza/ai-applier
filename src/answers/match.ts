import { z } from "zod";
import type { Llm } from "../llm/llm.js";
import type { Question } from "./bank.js";

const PREFILTER_LIMIT = 40;

const MatchSchema = z.object({
  matchId: z.number().int().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});

const MATCH_SYSTEM = `You decide whether a question on a job application form is the same question as one already saved in an applicant's answer bank, so the saved answer can be reused.

You receive the new question, whether it is factual, and a list of saved questions with their ids and the other wordings they have appeared under. "{company}" stands for whichever company the applicant is applying to.

Return the id of the saved question that asks for the same information, or null if none does. Same meaning is required, not the same topic: "Are you authorized to work in the US?" and "Will you require visa sponsorship?" are different questions, as are "Do you require sponsorship now?" and "Will you require sponsorship now or in the future?".

For factual questions (work authorization, sponsorship, citizenship, dates, GPA, demographics, prior employment, and similar), a match must ask for exactly the same fact, with the same polarity and scope, so that the saved answer is correct for the new question without any change. If you are not sure, return null.

confidence: "high" when the saved answer would certainly be correct for the new question, "medium" when it very likely would, "low" otherwise.`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9{}]+/g, " ").trim();

/** Trigrams of each word, padded at the word's edges (as in pg_trgm), so "authorized" and "authorization" overlap. */
function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of norm(text).split(" ").filter(Boolean)) {
    const w = `  ${word} `;
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Finds the saved question with the same meaning as `canonical`. Prefilters to the most similar
 * candidates, then asks the LLM. Accepts a high-confidence match, or a medium one for non-factual
 * questions. Returns the matched question id or null.
 */
export async function matchQuestion(llm: Llm, canonical: string, isFactual: boolean, candidates: Question[]): Promise<number | null> {
  if (!candidates.length) return null;
  const target = trigrams(canonical);
  const shortlist = candidates
    .map((q, i) => ({ q, i, score: Math.max(...[q.canonical, ...q.variants].map(t => similarity(target, trigrams(t)))) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, PREFILTER_LIMIT)
    .map(x => x.q);

  const out = await llm.structured({
    name: "match",
    schema: MatchSchema,
    system: MATCH_SYSTEM,
    effort: "low",
    content: JSON.stringify({
      newQuestion: canonical,
      isFactual,
      savedQuestions: shortlist.map(q => ({ id: q.id, question: q.canonical, otherWordings: q.variants, options: q.options })),
    }),
  });

  if (out.matchId === null || !shortlist.some(q => q.id === out.matchId)) return null;
  const accepted = out.confidence === "high" || (out.confidence === "medium" && !isFactual);
  return accepted ? out.matchId : null;
}
