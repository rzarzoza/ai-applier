import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import type { ProfileKey } from "../profile/profile.js";

/**
 * The "Other → type the real value" fallback. When a choice control asks for a name (school, major, degree, city,
 * country, employer) and the applicant's real value is not among its options, the control's "Other" option is picked
 * and the real value is typed into the box that asks to specify it. Only ever for names: never for yes/no, EEO,
 * work authorization, consent or any other fact, where "Other" would change the answer.
 */

/** Profile keys whose values are names of things that a list may simply not include. */
export const ENTITY_KEYS: ReadonlySet<ProfileKey> = new Set<ProfileKey>(["school", "major", "degree", "city", "state", "location", "country", "employers"]);

/** Labels of questions asking for such a name (for answers from the bank, a derived value or an override). */
const ENTITY_LABEL = /school|university|college|institution|major|discipline|field of study|degree|company|employer|organi[sz]ation|city/i;

/** Questions where "Other" is never a truthful stand-in, whatever their label also mentions. */
const NEVER_OTHER = /authori[sz]|sponsor|visa|citizen|immigration|eligib|legally|gender|sex\b|sexual|race|racial|ethnic|hispanic|latin[oax]|veteran|disab|orientation|pronoun|transgender|demographic|eeo|consent|agree|acknowledg|certif|attest|privacy|clearance|criminal|convict/i;

/** Option texts that stand for "my answer is not listed", most specific first (a longer match wins). */
const OTHER_PATTERNS = [
  "my school is not listed", "my university is not listed", "other school not listed", "other please specify", "school not listed",
  "university not listed", "institution not listed", "other school", "other university", "not listed", "none of the above", "other",
];

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const OPTION_KINDS = new Set<FieldSpec["kind"]>(["select", "combobox", "radio"]);

/** How specific an option is as an "Other" choice (the matched pattern's length), or 0 when it is not one. */
function otherScore(option: string): number {
  // A leading enumerator ("0 - School Not Listed", sorted first on Greenhouse) is not part of the option's meaning.
  const o = words(option).replace(/^\d+ /, "");
  let best = 0;
  for (const p of OTHER_PATTERNS) if ((o === p || o.startsWith(`${p} `)) && p.length > best) best = p.length;
  return best;
}

export const isOtherOption = (option: string) => otherScore(option) > 0;

/** The control's "Other" option (the most specific one, e.g. "Other school" over "Other"), or null. */
export function findOtherOption(options: readonly string[]): string | null {
  let pick: string | null = null;
  let best = 0;
  for (const o of options) {
    const s = otherScore(o);
    if (s > best) { best = s; pick = o; }
  }
  return pick;
}

/** The text an answer would put in a control, when it is a plain name (not yes/no, not "Other" itself). */
export function entityText(value: string | boolean | string[] | FieldAnswer | null | undefined): string | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  let text: string | null;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.length === 1 ? value[0]! : null;
  else text = value.type === "text" ? value.text : value.type === "option" ? value.option : null;
  const t = text?.trim() ?? "";
  if (!t || !/[a-z]/i.test(t) || /^(yes|no|true|false|n\/?a|none)$/i.test(t) || isOtherOption(t)) return null;
  return t;
}

/**
 * Whether a field may fall back to "Other": a choice control naming no protected fact, whose answer is a plain name
 * that came from an entity profile key (`entity`) or, for bank/derived/override answers, whose label asks for a name.
 */
export function otherEligible(field: FieldSpec, r: { source: string; answer: FieldAnswer; entity?: boolean }): boolean {
  if (!OPTION_KINDS.has(field.kind) || NEVER_OTHER.test(field.label) || entityText(r.answer) === null) return false;
  if (r.entity) return true;
  return ["bank", "derived", "template", "override"].includes(r.source) && ENTITY_LABEL.test(field.label);
}

/** Whether a profile key's value may fall back to "Other" in this field. */
export function entityProfileField(field: FieldSpec, key: ProfileKey, value: string | boolean | string[] | null): boolean {
  if (!ENTITY_KEYS.has(key) || !OPTION_KINDS.has(field.kind) || NEVER_OTHER.test(field.label)) return false;
  const text = entityText(value);
  if (text === null) return false;
  // A country only when the value reads as a country name.
  return key !== "country" || /^[a-z][a-z .'&()-]*$/i.test(text);
}

/** Labels of the box that asks to type what "Other" stands for. */
export const FOLLOW_UP = /other|specify|not listed|school name|university name|name of (your )?(school|university|institution|company|employer)|please (enter|list|provide|type)/i;
const TEXT_BOX = new Set<FieldSpec["kind"]>(["text", "textarea"]);

/**
 * The box to type the real value into after "Other" was picked in `controlId`: among the two fields after the control
 * (form order), one not handled yet (`handled`) that is a text box asking to specify, or any new text box right after
 * the control. A field already handled ends the search: the control's own box would come before it.
 */
export function followUpBox(present: readonly FieldSpec[], controlId: string, handled: (id: string) => boolean): FieldSpec | null {
  const i = present.findIndex(f => f.id === controlId);
  if (i < 0) return null;
  for (let j = i + 1; j < Math.min(present.length, i + 3); j++) {
    const f = present[j]!;
    if (handled(f.id)) return null;
    if (!TEXT_BOX.has(f.kind)) continue;
    if (FOLLOW_UP.test(f.label) || j === i + 1) return f;
  }
  return null;
}

/** Whether a field looks like the "specify" box of the choice control just before it (so it is held back a round). */
export function looksLikeFollowUp(fields: readonly FieldSpec[], index: number): boolean {
  const f = fields[index];
  if (!f || !TEXT_BOX.has(f.kind) || !FOLLOW_UP.test(f.label)) return false;
  return fields.slice(Math.max(0, index - 2), index).some(p => OPTION_KINDS.has(p.kind));
}

const GENERIC_WORDS = new Set(["university", "college", "institute", "institution", "school", "of", "the", "and", "at", "in", "for", "de", "inc", "llc", "corp", "company"]);

/** The value's distinctive words to search a list with ("Rice" for "Rice University"), at most two. */
export function distinctiveWords(value: string): string[] {
  const parts = value.split(/[^A-Za-z0-9&]+/).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w.toLowerCase()));
  return [...new Set(parts)].slice(0, 2);
}
