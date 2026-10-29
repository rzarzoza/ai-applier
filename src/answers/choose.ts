/**
 * Picking an option for a value without an LLM, as the runner's widget handlers do it: exact text, then the only option
 * starting with the value, then the degree mapper ("B.S." -> "Bachelor's Degree"), the place rules ("Houston, Texas"
 * -> "Houston, Texas, United States", never "Houston County, Alabama") and the country synonyms ("USA" ->
 * "United States +1"). Plain functions with no dependencies beyond other plain modules, so the browser extension
 * bundles them too; the LLM mapping (adaptAnswer) stays on the app's side.
 */
import { COUNTRY_LABEL, countryKey, countryQueries, dialCode, isKnownCountry, pickCountry } from "./country.js";
import { degreeQueries, isDegreeQuestion, pickDegree } from "./degree.js";
import { isLocationAnswer, locationQueries, norm, parsePlace, pickLocation, placeMatches, yesNo } from "./location.js";
import { distinctiveWords } from "./other.js";

export interface ChooseContext {
  /** The field's question (decides whether the value is a place, a degree or a country). */
  label: string;
  /** Whether the applicant's degree is still in progress (see degree.ts). */
  inProgress?: boolean | null;
}

/** Where the applicant lives, from the profile: lets a bare "Houston" be searched and matched as "Houston, Texas". */
export interface PlaceHint { city: string | null; state: string | null; country: string | null }

export type Choice = { option: string; sure: boolean } | null;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** isLocationAnswer without its type guard (a string that isn't a place is still a string). */
const isPlace = (label: string, value: string): boolean => isLocationAnswer({ label }, value);

/**
 * The value to look a place up with: a bare city ("Houston") that is the profile's city becomes "Houston, Texas", so
 * only Houston in Texas matches. Any other value is returned as is.
 */
export function placeValue(label: string, value: string, place?: PlaceHint | null): string {
  if (!place?.city || !place.state || !isPlace(label, value)) return value;
  const parsed = parsePlace(value);
  if (!parsed || parsed.region || norm(parsed.city) !== norm(place.city)) return value;
  return `${squash(value.split(",")[0]!)}, ${place.state}`;
}

/** Whether a value should be matched as a country (the field asks for one, or the value is a known country name). */
function asCountry(label: string, value: string): boolean {
  return COUNTRY_LABEL.test(label) || isKnownCountry(value) || /^\(?\+\s?\d{1,4}\)?$/.test(value.trim());
}

/**
 * The option `value` stands for among `options`, or null. `sure` is true for an exact match: a caller watching a
 * list that is still loading may take it at once, and should wait for the list to settle before taking any other.
 */
export function chooseOption(value: string, options: readonly string[], ctx: ChooseContext): Choice {
  const want = norm(value);
  if (!want || !options.length) return null;
  const texts = options.map(squash);
  const exact = texts.findIndex(t => norm(t) === want);
  if (exact >= 0) return { option: options[exact]!, sure: true };
  // A place resolves to the real place or to nothing: no prefix guesses ("Houston" -> "Houston County").
  if (isPlace(ctx.label, value)) {
    const picked = pickLocation(value, texts);
    return picked === null ? null : { option: options[texts.indexOf(picked)]!, sure: false };
  }
  if (asCountry(ctx.label, value)) {
    const picked = pickCountry(value, texts);
    if (picked !== null) return { option: options[texts.indexOf(picked)]!, sure: false };
  }
  if (isDegreeQuestion(ctx.label, value, texts)) {
    const picked = pickDegree(value, texts, ctx.inProgress);
    if (picked !== null) return { option: options[texts.indexOf(picked)]!, sure: false };
  }
  // "Yes" never stands for "Yes, but I will need sponsorship": a qualified option is the LLM's call, which sees the question.
  if (yesNo(value) !== null) return null;
  const prefixed = texts.flatMap((t, i) => (norm(t).startsWith(want) ? [i] : []));
  if (prefixed.length === 1) return { option: options[prefixed[0]!]!, sure: false };
  return null;
}

/** What to type into a searchable list to find `value`: the value, then the words its kind of answer is listed under. */
export function searchQueries(value: string, ctx: ChooseContext): string[] {
  const v = squash(value);
  if (!v) return [];
  if (isPlace(ctx.label, v)) return locationQueries(v);
  const out = [v];
  if (asCountry(ctx.label, v)) out.push(...countryQueries(v));
  out.push(...degreeQueries(v), ...distinctiveWords(v));
  return [...new Set(out.filter(Boolean))];
}

/**
 * Up to `n` options closest to `value`, best first, for the user to pick from when nothing matched: same country, the
 * place's city, shared words, a shared start; ties keep the list's order. With nothing in common, the list's first ones.
 */
export function closestOptions(value: string, options: readonly string[], n = 5): string[] {
  const want = norm(value);
  const words = new Set(want.split(" ").filter(w => w.length > 1));
  const place = parsePlace(value);
  const key = countryKey(value);
  const code = dialCode(value);
  const score = (o: string) => {
    const t = norm(o);
    let s = 0;
    if (key && countryKey(o) === key) s += 50;
    if (code && dialCode(o) === code) s += 10;
    if (place && placeMatches(place, o)) s += 40;
    else if (place && ` ${t} `.includes(` ${place.city} `)) s += 15;
    const ow = t.split(" ");
    s += ow.filter(w => words.has(w)).length * 5;
    if (want && (t.startsWith(want) || want.startsWith(t))) s += 8;
    return s;
  };
  const uniq = [...new Set(options.map(squash).filter(Boolean))];
  return uniq.map((o, i) => ({ o, i, s: score(o) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map(x => x.o);
}
