import { z } from "zod";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import type { Llm } from "../llm/llm.js";
import { isDegreeQuestion, pickDegree, degreeCompatible, type DegreeHints } from "./degree.js";
import { isOtherOption } from "./other.js";

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

/** US states (and DC, PR) by postal code, to match "Houston, Texas" against "Houston, TX, USA" and back. */
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  PR: "Puerto Rico", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const US_NAMES = ["united states", "united states of america", "usa", "us"];

/** Questions asking where the applicant is located (a place typeahead or list). Not "relocation". */
const LOCATION_LABEL = /\blocation\b|\bcity\b|where .*located/i;

/** Whether this field asks for a place and `value` names one (a yes/no answer to "...this location?" does not). */
export function isLocationAnswer(field: Pick<FieldSpec, "label">, value: string | boolean | string[]): value is string {
  return typeof value === "string" && LOCATION_LABEL.test(field.label) && yesNo(value) === null && !!norm(value);
}

type Place = { city: string; region: { name: string; code: string | null } | null; country: string | null };

/** "Houston, Texas" / "Houston, TX, USA" as city, region (state name and code when known) and country. */
function parsePlace(value: string): Place | null {
  const parts = value.split(",").map(p => p.trim()).filter(Boolean);
  const city = norm(parts[0] ?? "");
  if (!city) return null;
  let region: Place["region"] = null;
  let country: string | null = null;
  for (const part of parts.slice(1)) {
    const code = part.trim().toUpperCase();
    const byCode = /^[A-Z]{2}$/.test(code) ? US_STATES[code] : undefined;
    const byName = Object.entries(US_STATES).find(([, n]) => norm(n) === norm(part));
    if (!region && byCode) region = { name: norm(byCode), code: code.toLowerCase() };
    else if (!region && byName) region = { name: norm(byName[1]), code: byName[0].toLowerCase() };
    else if (!region) region = { name: norm(part), code: null };
    else country ??= norm(part);
  }
  if (!country && region?.code) country = "united states";
  return { city, region, country };
}

const hasWords = (outer: string, inner: string) => !!inner && ` ${outer} `.includes(` ${inner} `);

/**
 * Whether an option names the place: one of its parts contains the city and another, later part the state's name or
 * code (when known) — so "Albany, New York" is not New York City.
 */
function placeMatches(place: Place, option: string): boolean {
  const comps = option.split(",").map(norm).filter(Boolean);
  const cityAt = comps.findIndex(c => hasWords(c, place.city));
  if (cityAt < 0) return false;
  if (!place.region) return true;
  const { name, code } = place.region;
  return comps.slice(cityAt + 1).some(c => hasWords(c, name) || (!!code && (c === code || c.startsWith(`${code} `))));
}

/** What to type into a place search for `value`: the value itself, then the city alone, then "City, ST". */
export function locationQueries(value: string): string[] {
  const place = parsePlace(value);
  const city = value.split(",")[0]!.trim();
  const out = [value.trim(), city];
  if (place?.region?.code) {
    out.push(`${city}, ${place.region.code.toUpperCase()}`);
    out.push(`${city}, ${US_STATES[place.region.code.toUpperCase()]}`);
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * The option naming the applicant's place, or null: an option equal to `value`, else one containing the city and (when
 * the value names one) the state's name or 2-letter code — "Houston, Texas, United States" or "Houston, TX, USA" for
 * "Houston, Texas", never "Houston County, Alabama" or a list without Houston. Among several, the one whose first part
 * is the city itself, then the one naming the country, then the shortest. A value without a state only takes an option
 * whose first part is the city, and only when that is unambiguous.
 */
export function pickLocation(value: string, options: readonly string[]): string | null {
  const exact = options.find(o => norm(o) === norm(value));
  if (exact !== undefined) return exact;
  const place = parsePlace(value);
  if (!place) return null;
  const hits = options.filter(o => placeMatches(place, o) && (place.region || norm(o.split(",")[0]!) === place.city));
  if (!place.region && new Set(hits.map(norm)).size > 1) return null;
  const countries = place.country ? (place.region?.code ? US_NAMES : [place.country]) : [];
  const score = (o: string) => {
    const comps = o.split(",").map(norm);
    return (comps[0] === place.city ? 4 : 0) + (comps.slice(1).some(c => countries.includes(c) || countries.some(k => hasWords(c, k))) ? 2 : 0);
  };
  let best: string | null = null;
  for (const o of hits) {
    if (best === null || score(o) > score(best) || (score(o) === score(best) && o.length < best.length)) best = o;
  }
  return best;
}

const ADAPT_OPTION_SYSTEM = `You map a job applicant's stored answer onto one option of an application form field.

You receive the field's question, its options, and the stored answer. Return the option that states the same thing as the stored answer, copied exactly as it appears in the options list.

Return null when no option means the same as the stored answer, or when more than one option could. This matters most for factual answers (work authorization, sponsorship, citizenship, dates, GPA, demographics, prior employment): pick an option only if it is clearly equivalent, and never pick one that changes the meaning, polarity, or scope of the stored answer. A wrong option is worse than none. Never pick a catch-all option such as "Other", "Not listed" or "None of the above" for a specific stored answer: return null instead.`;

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

/**
 * Whether `option` may stand for the stored value: an "Other"-like option ("Other", "Not listed", "Other (please
 * specify)"...) only when the value itself says "Other". Mapping a real value onto "Other" changes the answer; only the
 * explicit Other fallback (answers/other.ts, for names a list truly lacks) may pick it.
 */
const mayStandFor = (value: string | boolean | string[], option: string) => !isOtherOption(option) || isOtherOption(asText(value));

function fieldContext(field: FieldSpec, job: JobContext) {
  return { question: field.label, description: field.description ?? null, company: job.company, jobTitle: job.title };
}

/** What the caller knows beyond the field itself (see answers/degree.ts). */
export type AdaptHints = DegreeHints;

/**
 * Converts a stored value into an answer for this field: deterministic where possible, otherwise one
 * low-effort LLM call. Returns null when the value cannot be expressed in the field without guessing. Never maps a value
 * onto an "Other"-like option (unless the value itself says "Other"): that is the caller's explicit fallback to make.
 * A degree ("B.S.") maps onto the form's option of the same level ("Bachelor of Science", "Bachelor's Degree",
 * "Undergraduate"...) without an LLM, and never onto another level, whoever picks it.
 */
export async function adaptAnswer(llm: Llm, value: string | boolean | string[], field: FieldSpec, job: JobContext, hints: AdaptHints = {}): Promise<FieldAnswer | null> {
  const options = field.options ?? [];

  if (field.kind === "checkbox") {
    const b = typeof value === "boolean" ? value : typeof value === "string" ? yesNo(value) : null;
    return b === null ? null : { type: "check", checked: b };
  }

  if (field.kind === "checkbox-group") {
    if (!options.length) return null;
    const whole = typeof value === "string" ? pickOption(value, options) : null;
    if (whole && mayStandFor(value, whole)) return { type: "options", options: [whole] };
    const parts: (string | boolean)[] = Array.isArray(value) ? value
      : typeof value === "string" ? value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean) : [value];
    const picked = parts.map(p => pickOption(p, options));
    if (picked.length && picked.every((p, i) => p !== null && mayStandFor(parts[i]!, p))) return { type: "options", options: [...new Set(picked as string[])] };
    const out = await llm.structured({
      name: "adapt", schema: OptionsSchema, system: ADAPT_OPTIONS_SYSTEM, effort: "low",
      content: JSON.stringify({ ...fieldContext(field, job), options, storedAnswer: asText(value) }),
    });
    const chosen = out.options ?? [];
    if (!chosen.length || !chosen.every(o => options.includes(o) && mayStandFor(value, o))) return null;
    return { type: "options", options: [...new Set(chosen)] };
  }

  if (OPTION_KINDS.has(field.kind) && options.length && isLocationAnswer(field, value)) {
    // A place resolves to the real place or to nothing: no containment guess ("Houston County, Alabama" for
    // "Houston"), and an LLM pick must still name the city (and state) — never an unrelated place.
    const picked = pickLocation(value, options);
    if (picked && mayStandFor(value, picked)) return { type: "option", option: picked };
    const place = parsePlace(value);
    const out = await llm.structured({
      name: "adapt", schema: OptionSchema, system: ADAPT_OPTION_SYSTEM, effort: "low",
      content: JSON.stringify({ ...fieldContext(field, job), options, storedAnswer: value }),
    });
    const ok = out.option !== null && options.includes(out.option) && !!place && placeMatches(place, out.option) && mayStandFor(value, out.option);
    return ok ? { type: "option", option: out.option! } : null;
  }

  if (OPTION_KINDS.has(field.kind) && options.length) {
    const flat = Array.isArray(value) ? value.join(", ") : value;
    const degree = typeof flat === "string" && isDegreeQuestion(field.label, flat, options, hints);
    if (degree) {
      const picked = pickDegree(flat, options, hints.inProgress);
      if (picked) return { type: "option", option: picked };
    }
    // A degree never lands on an option of another level ("Master's" for "B.S."), whether by containment or the LLM.
    const fits = (o: string) => mayStandFor(value, o) && (!degree || degreeCompatible(flat as string, o));
    const picked = pickOption(flat, options);
    if (picked && fits(picked)) return { type: "option", option: picked };
    const out = await llm.structured({
      name: "adapt", schema: OptionSchema, system: ADAPT_OPTION_SYSTEM, effort: "low",
      content: JSON.stringify({ ...fieldContext(field, job), options, storedAnswer: asText(value) }),
    });
    return out.option !== null && options.includes(out.option) && fits(out.option) ? { type: "option", option: out.option } : null;
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

const VARIANTS_SYSTEM = `You help find a name in a form's searchable option list (schools, majors, degrees, cities, countries, employers).

You receive the form's question and a name the applicant gave. Return up to 3 other names the SAME entity is commonly listed under: its official full name, a well-known short form or abbreviation, or a former name (e.g. "William Marsh Rice University" or "Rice" for "Rice University"). Never return a different entity (no other campus, branch, or similarly named place). Return an empty list when you know of none.`;

const VariantsSchema = z.object({ variants: z.array(z.string()) });

/** Up to three other names the same entity may be listed under, to search a list with (one low-effort LLM call). */
export async function nameVariants(llm: Llm, value: string, field: FieldSpec, job: JobContext): Promise<string[]> {
  const out = await llm.structured({
    name: "variants", schema: VariantsSchema, system: VARIANTS_SYSTEM, effort: "low",
    content: JSON.stringify({ ...fieldContext(field, job), name: value }),
  });
  const seen = new Set([norm(value)]);
  return out.variants.map(v => v.trim()).filter(v => {
    const n = norm(v);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  }).slice(0, 3);
}
