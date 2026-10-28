import { z } from "zod";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import type { Llm } from "../llm/llm.js";

const OPTION_KINDS = new Set<FieldSpec["kind"]>(["select", "combobox", "radio"]);
const TEXT_KINDS = new Set<FieldSpec["kind"]>(["text", "textarea", "email", "tel", "url", "number", "date"]);

/** Words that flip a statement's meaning; a containment match across one of these is rejected. */
const NEGATIONS = new Set(["not", "no", "non", "never", "neither", "nor", "don", "dont", "doesn", "doesnt", "isn", "aren", "won", "without", "decline", "declined"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function yesNo(value: string): boolean | null {
  const v = norm(value);
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return null;
}

/** Whether `inner` appears as whole words in `outer`, and if so whether the leftover words carry a negation. */
function containment(outer: string, inner: string): "none" | "clean" | "negated" {
  if (!inner || !` ${outer} `.includes(` ${inner} `)) return "none";
  const leftover = ` ${outer} `.replace(` ${inner} `, " ").trim().split(" ");
  return leftover.some(w => NEGATIONS.has(w)) ? "negated" : "clean";
}

/**
 * Maps a stored value onto one of a field's options without an LLM. A yes/no value (boolean or the
 * words yes/no/true/false) only maps to an option that is exactly yes/no; a qualified option such as
 * "Yes, but I need sponsorship" is left to the LLM, which sees the question. Other strings: exact
 * match (case-insensitive), then whole-word containment either way. Null when nothing or more than
 * one option fits, or when any containment match crosses a negation.
 */
export function pickOption(value: string | boolean, options: string[]): string | null {
  const unique = (xs: string[]) => (xs.length === 1 ? xs[0]! : null);
  const bool = typeof value === "boolean" ? value : yesNo(value);
  if (bool !== null) {
    const words = bool ? ["yes", "true"] : ["no", "false"];
    return unique(options.filter(o => words.includes(norm(o))));
  }
  const v = norm(value as string);
  if (!v) return null;
  const exact = options.filter(o => norm(o) === v);
  if (exact.length) return unique(exact);
  const clean: string[] = [];
  let negated = 0;
  for (const o of options) {
    const n = norm(o);
    const kinds = [containment(n, v), containment(v, n)];
    if (kinds.includes("clean")) clean.push(o);
    else if (kinds.includes("negated")) negated++;
  }
  return negated ? null : unique(clean);
}

const ADAPT_OPTION_SYSTEM = `You map a job applicant's stored answer onto one option of an application form field.

You receive the field's question, its options, and the stored answer. Return the option that states the same thing as the stored answer, copied exactly as it appears in the options list.

Return null when no option means the same as the stored answer, or when more than one option could. This matters most for factual answers (work authorization, sponsorship, citizenship, dates, GPA, demographics, prior employment): pick an option only if it is clearly equivalent, and never pick one that changes the meaning, polarity, or scope of the stored answer. A wrong option is worse than none.`;

const ADAPT_OPTIONS_SYSTEM = `You map a job applicant's stored answer onto the options of a multi-select application form field.

You receive the field's question, its options, and the stored answer. Return every option the stored answer states, each copied exactly as it appears in the options list.

Return null when the stored answer does not clearly correspond to the options. This matters most for factual answers (demographics, work authorization, and similar): never select an option the stored answer does not state. A wrong selection is worse than none.`;

const SHORTEN_SYSTEM = `You shorten a job applicant's answer so it fits a form field's character limit.

Keep the meaning, the facts, and the first-person voice. Remove words; do not add information, claims, or experience that is not in the original. The result must be at most the stated number of characters, counting spaces.`;

const OptionSchema = z.object({ option: z.string().nullable() });
const OptionsSchema = z.object({ options: z.array(z.string()).nullable() });
const TextSchema = z.object({ text: z.string() });

const asText = (value: string | boolean | string[]): string =>
  typeof value === "boolean" ? (value ? "Yes" : "No") : Array.isArray(value) ? value.join(", ") : value;

function fieldContext(field: FieldSpec, job: JobContext) {
  return { question: field.label, description: field.description ?? null, company: job.company, jobTitle: job.title };
}

/**
 * Converts a stored value into an answer for this field: deterministic where possible, otherwise one
 * low-effort LLM call. Returns null when the value cannot be expressed in the field without guessing.
 */
export async function adaptAnswer(llm: Llm, value: string | boolean | string[], field: FieldSpec, job: JobContext): Promise<FieldAnswer | null> {
  const options = field.options ?? [];

  if (field.kind === "checkbox") {
    const b = typeof value === "boolean" ? value : typeof value === "string" ? yesNo(value) : null;
    return b === null ? null : { type: "check", checked: b };
  }

  if (field.kind === "checkbox-group") {
    if (!options.length) return null;
    const whole = typeof value === "string" ? pickOption(value, options) : null;
    if (whole) return { type: "options", options: [whole] };
    const parts: (string | boolean)[] = Array.isArray(value) ? value
      : typeof value === "string" ? value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean) : [value];
    const picked = parts.map(p => pickOption(p, options));
    if (picked.length && picked.every(p => p !== null)) return { type: "options", options: [...new Set(picked as string[])] };
    const out = await llm.structured({
      name: "adapt", schema: OptionsSchema, system: ADAPT_OPTIONS_SYSTEM, effort: "low",
      content: JSON.stringify({ ...fieldContext(field, job), options, storedAnswer: asText(value) }),
    });
    const chosen = out.options ?? [];
    if (!chosen.length || !chosen.every(o => options.includes(o))) return null;
    return { type: "options", options: [...new Set(chosen)] };
  }

  if (OPTION_KINDS.has(field.kind) && options.length) {
    const flat = Array.isArray(value) ? value.join(", ") : value;
    const picked = pickOption(flat, options);
    if (picked) return { type: "option", option: picked };
    const out = await llm.structured({
      name: "adapt", schema: OptionSchema, system: ADAPT_OPTION_SYSTEM, effort: "low",
      content: JSON.stringify({ ...fieldContext(field, job), options, storedAnswer: asText(value) }),
    });
    return out.option !== null && options.includes(out.option) ? { type: "option", option: out.option } : null;
  }

  // A combobox with no known options is a typeahead: type the value and let the filler pick.
  if (TEXT_KINDS.has(field.kind) || field.kind === "combobox") {
    const text = asText(value).trim();
    if (!text) return null;
    const max = field.maxLength;
    if (!max || text.length <= max) return { type: "text", text };
    const out = await llm.structured({
      name: "adapt", schema: TextSchema, system: SHORTEN_SYSTEM, effort: "low",
      content: JSON.stringify({ ...fieldContext(field, job), maxCharacters: max, answer: text }),
    });
    const short = out.text.trim();
    return short && short.length <= max ? { type: "text", text: short } : null;
  }

  // select/radio without options, or a file field: nothing safe to put there.
  return null;
}
