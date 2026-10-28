/**
 * Degree equivalence: "B.S.", "BS", "Bachelor of Science", "Bachelors Degree", "Undergraduate" and "BS/BA" all name a
 * bachelor's degree. Values and options are parsed into a level (associate, bachelor, master, doctorate, high school,
 * some college) and, when stated, a flavor (science, arts, engineering, business...) and a status (in progress vs
 * completed), so a stored degree maps onto whatever a form offers without an LLM, and never onto another level.
 */

export type DegreeLevel = "high-school" | "some-college" | "associate" | "bachelor" | "master" | "doctorate";
export type DegreeStatus = "in-progress" | "completed";

export interface Degree {
  level: DegreeLevel;
  /** The degree's kind ("of Science", "B.A." → arts...); several for combined options such as "BS/BA". */
  flavors: Set<string>;
  status: DegreeStatus | null;
  /** True when the level is named only generically ("Undergraduate", "Graduate"). */
  generic: boolean;
}

/** Abbreviations (periods removed, lowercased) → level and flavor. */
const ABBREVIATIONS: Record<string, [DegreeLevel, string | null]> = {
  aa: ["associate", "arts"], as: ["associate", "science"], aas: ["associate", "science"],
  bs: ["bachelor", "science"], bsc: ["bachelor", "science"], ba: ["bachelor", "arts"], beng: ["bachelor", "engineering"],
  bse: ["bachelor", "engineering"], bfa: ["bachelor", "arts"], bba: ["bachelor", "business"], bcs: ["bachelor", "science"],
  ms: ["master", "science"], msc: ["master", "science"], ma: ["master", "arts"], meng: ["master", "engineering"],
  mse: ["master", "engineering"], mfa: ["master", "arts"], mba: ["master", "business"], mph: ["master", "public health"],
  phd: ["doctorate", "philosophy"], dphil: ["doctorate", "philosophy"], md: ["doctorate", "medicine"], jd: ["doctorate", "law"],
  edd: ["doctorate", "education"], ged: ["high-school", null],
};

/** Level words (lowercased, apostrophes removed). */
const WORDS: Record<string, DegreeLevel> = {
  associate: "associate", associates: "associate",
  bachelor: "bachelor", bachelors: "bachelor", baccalaureate: "bachelor",
  master: "master", masters: "master",
  doctor: "doctorate", doctorate: "doctorate", doctoral: "doctorate", doctors: "doctorate",
};
const GENERIC: Record<string, DegreeLevel> = {
  undergraduate: "bachelor", undergrad: "bachelor", graduate: "master", postgraduate: "master", grad: "master",
};

/** "of Science" / "of Fine Arts" → the flavor it names. */
const FLAVOR_WORDS: Record<string, string> = {
  science: "science", sciences: "science", arts: "arts", art: "arts", fine: "arts", engineering: "engineering",
  business: "business", philosophy: "philosophy", medicine: "medicine", law: "law", laws: "law", education: "education",
  applied: "science", technology: "science",
};

const IN_PROGRESS = /\b(pursu\w*|in progress|in-progress|currently|current|enrolled|candidate|expected|working (?:toward|towards)|student|ongoing|anticipated)\b/i;
const COMPLETED = /\b(completed?|graduated|earned|received|conferred|obtained)\b/i;

/**
 * Parses a degree value or option. Null when it names no degree level, or more than one ("Bachelor's or Master's"):
 * such a text is never a match for a single level.
 */
export function parseDegree(text: string): Degree | null {
  const flat = text.replace(/[’'`]/g, "").replace(/\./g, "");
  const lower = flat.toLowerCase();
  const explicit = new Set<DegreeLevel>();
  const generic = new Set<DegreeLevel>();
  const flavors = new Set<string>();

  if (/\bhigh ?school\b|\bsecondary school\b/.test(lower)) explicit.add("high-school");
  else if (/\bsome college\b|\bno degree\b/.test(lower)) explicit.add("some-college");

  const tokens = flat.split(/[^A-Za-z0-9]+/).filter(Boolean);
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase();
    const abbr = ABBREVIATIONS[t];
    // Two-letter abbreviations that are also words ("as", "ma", "ms") count only when written in capitals ("AS", "M.S.").
    const looksAbbr = t.length > 2 || t === "bs" || t === "ba" || (t === "as" ? tok === "AS" : tok !== t);
    if (abbr && looksAbbr) {
      explicit.add(abbr[0]);
      if (abbr[1]) flavors.add(abbr[1]);
      return;
    }
    const word = WORDS[t];
    if (word) {
      explicit.add(word);
      if (tokens[i + 1]?.toLowerCase() === "of") {
        const f = FLAVOR_WORDS[tokens[i + 2]?.toLowerCase() ?? ""];
        if (f) flavors.add(f);
      }
      return;
    }
    if (GENERIC[t]) generic.add(GENERIC[t]);
  });

  // A generic word next to an explicit level ("Graduate degree (Master's)", "High school graduate") defers to it.
  const levels = explicit.size ? explicit : generic;
  if (levels.size !== 1) return null;
  const level = [...levels][0]!;
  const status: DegreeStatus | null = IN_PROGRESS.test(text) ? "in-progress" : COMPLETED.test(text) ? "completed" : null;
  return { level, flavors, status, generic: !explicit.size };
}

/** Questions asking for the applicant's degree (or its level), not its major. */
export const DEGREE_LABEL = /degree|education level|level of education|highest .*education|academic level|level of study/i;

export interface DegreeHints {
  /** The field is known to ask for the degree (e.g. classified as the profile's degree). */
  degreeField?: boolean;
  /** Whether the applicant's degree is still in progress (null/undefined: unknown). */
  inProgress?: boolean | null;
}

/**
 * Whether `value` should go through the degree mapper for this field: it names a degree level, and the field asks for a
 * degree (by label or hint) or its options are a list of degree levels.
 */
export function isDegreeQuestion(label: string, value: string, options: readonly string[], hints: DegreeHints = {}): boolean {
  if (!parseDegree(value)) return false;
  if (hints.degreeField || DEGREE_LABEL.test(label)) return true;
  const levels = new Set(options.map(o => parseDegree(o)?.level).filter(Boolean));
  return levels.size >= 2;
}

/**
 * The option standing for the degree `value`, or null. Only options of the same level qualify, never "Other"-like ones
 * (they parse to no level) nor one of a different flavor ("Bachelor of Arts" for "B.S."). Ranked by: matching status
 * when known ("Currently pursuing a Bachelor's" for a current student, a completed one otherwise), then the same flavor
 * ("Bachelor of Science (BS)"), then a level-only option naming the level ("Bachelor's Degree", "BS/BA") over a generic
 * one ("Undergraduate"), then the shortest.
 */
export function pickDegree(value: string, options: readonly string[], inProgress?: boolean | null): string | null {
  const want = parseDegree(value);
  if (!want) return null;
  const wantStatus: DegreeStatus | null = want.status ?? (inProgress === true ? "in-progress" : inProgress === false ? "completed" : null);
  let best: { option: string; score: number[] } | null = null;
  for (const option of options) {
    const got = parseDegree(option);
    if (!got || got.level !== want.level) continue;
    // A different kind of degree of the same level is a different degree.
    if (got.flavors.size && want.flavors.size && ![...got.flavors].some(f => want.flavors.has(f))) continue;
    // A finished degree is never "currently pursuing" one.
    if (wantStatus === "completed" && got.status === "in-progress") continue;
    const score = [
      wantStatus && got.status === wantStatus ? 1 : 0,
      want.flavors.size && got.flavors.size === want.flavors.size && [...got.flavors].every(f => want.flavors.has(f)) ? 1 : 0,
      got.generic ? 0 : 1,
      // Without a known status, the option that claims none ("Bachelor's Degree") over a qualified one.
      !wantStatus && got.status === null ? 1 : 0,
      -option.length,
    ];
    if (!best || compare(score, best.score) > 0) best = { option, score };
  }
  return best?.option ?? null;
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/**
 * Whether `option` may stand for degree `value` at all: it names no level (unparsed text, left to the caller's other
 * checks), or the same level without a conflicting flavor ("Bachelor of Arts" never stands for "B.S.").
 */
export function degreeCompatible(value: string, option: string): boolean {
  const want = parseDegree(value);
  const got = parseDegree(option);
  if (!want || !got) return true;
  if (got.level !== want.level) return false;
  return !got.flavors.size || !want.flavors.size || [...got.flavors].some(f => want.flavors.has(f));
}

/** Words to search a degree typeahead with ("Bachelor" for "B.S."). */
export function degreeQueries(value: string): string[] {
  const d = parseDegree(value);
  if (!d) return [];
  const word: Record<DegreeLevel, string[]> = {
    "high-school": ["High School"], "some-college": ["Some college"], associate: ["Associate"],
    bachelor: ["Bachelor", "Undergraduate"], master: ["Master", "Graduate"], doctorate: ["Doctor", "PhD"],
  };
  return word[d.level];
}

/** Whether a degree that ends in `graduationMonth` ("YYYY-MM") is still in progress at `now`; null when unknown. */
export function degreeInProgress(graduationMonth: string | null | undefined, now: Date = new Date()): boolean | null {
  const m = /^(\d{4})-(\d{2})/.exec(graduationMonth ?? "");
  if (!m) return null;
  const current = now.getFullYear() * 12 + now.getMonth();
  return Number(m[1]) * 12 + (Number(m[2]) - 1) >= current;
}
