/**
 * Countries in answers and option lists: "USA", "US", "United States of America" and "America" are all the option
 * "United States +1" of a phone-country picker, and a dialing code ("+1") stands for its country. Plain functions with
 * no dependencies, so the browser extension bundles them too.
 */

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** Other names a country goes by, keyed by the name pickers usually show. */
const SYNONYMS: Record<string, string[]> = {
  "united states": ["usa", "us", "u s", "u s a", "united states of america", "america", "the united states", "the us", "the usa", "united states us", "united states usa"],
  "united kingdom": ["uk", "u k", "great britain", "britain", "gb", "united kingdom of great britain and northern ireland", "england", "the uk"],
  "united arab emirates": ["uae", "u a e", "emirates"],
  "south korea": ["korea", "republic of korea", "korea republic of", "korea south", "korea (south)", "rok"],
  "north korea": ["korea democratic people s republic of", "dprk", "korea north"],
  "russia": ["russian federation"],
  "vietnam": ["viet nam"],
  "iran": ["iran islamic republic of"],
  "taiwan": ["taiwan province of china", "taiwan roc", "republic of china"],
  "china": ["people s republic of china", "prc", "mainland china"],
  "netherlands": ["the netherlands", "holland"],
  "czech republic": ["czechia"],
  "turkey": ["turkiye"],
  "india": ["bharat"],
  "germany": ["deutschland"],
};

/** Synonym (normalized) -> the name it stands for. */
const CANONICAL = new Map<string, string>();
for (const [name, alts] of Object.entries(SYNONYMS)) {
  CANONICAL.set(name, name);
  for (const a of alts) CANONICAL.set(norm(a), name);
}

/** A dialing code in an option ("+1", "(+44)", "+1-684") and what is left of the text without it. */
const DIAL = /\(?\+\s?(\d{1,4})(?:[\s-]\d{1,4})?\)?/;

/** The dialing code an option or value names ("+1"), or null. */
export function dialCode(text: string): string | null {
  const m = DIAL.exec(text);
  return m ? `+${m[1]}` : null;
}

/** The country name a text stands for, normalized ("united states" for "USA" or "🇺🇸 United States (+1)"); null if none. */
export function countryKey(text: string): string | null {
  const stripped = norm(text.replace(DIAL, " "));
  if (!stripped) return null;
  return CANONICAL.get(stripped) ?? stripped;
}

/** Whether a value names a country this module knows by another name (so a picker may list it differently). */
export const isKnownCountry = (value: string) => CANONICAL.has(norm(value.replace(DIAL, " ")));

/** Questions asking for a country (a phone picker's country or dialing code included). */
export const COUNTRY_LABEL = /\bcountry\b|nationality|citizenship|country code|dial(ing)? code|phone code|calling code/i;

/** The country names to search a picker with for `value` ("United States", then "United" for "USA"). */
export function countryQueries(value: string): string[] {
  const key = countryKey(value);
  if (!key) return [];
  const pretty = key.replace(/\b\w/g, c => c.toUpperCase());
  return [...new Set([value.trim(), pretty, pretty.split(" ")[0]!])].filter(Boolean);
}

/** Dialing codes shared by several countries, and the country a bare code stands for. */
const DIAL_HOME: Record<string, string> = { "+1": "united states", "+7": "russia", "+44": "united kingdom", "+61": "australia", "+39": "italy", "+47": "norway", "+358": "finland", "+590": "guadeloupe", "+262": "reunion", "+212": "morocco" };

/**
 * The option standing for the country `value`, or null: an option naming the same country under any of its names,
 * with or without a dialing code ("United States +1" for "USA", "+1 United States" for "United States of America").
 * A bare dialing code ("+1") picks the option with that code and the country it is home to (the United States for
 * +1, not Canada or American Samoa); a code with one option picks that one. Several options for the same country
 * (duplicated lists) give the shortest.
 */
export function pickCountry(value: string, options: readonly string[]): string | null {
  const v = value.trim();
  if (!v) return null;
  const bare = /^\(?\+?\s?\d{1,4}\)?$/.test(v);
  if (bare) {
    const code = `+${v.replace(/\D/g, "")}`;
    const withCode = options.filter(o => dialCode(o) === code);
    if (withCode.length === 1) return withCode[0]!;
    const home = DIAL_HOME[code];
    const homes = home ? withCode.filter(o => countryKey(o) === home) : [];
    return shortest(homes) ?? (withCode.length && new Set(withCode.map(o => countryKey(o))).size === 1 ? shortest(withCode) : null);
  }
  const key = countryKey(v);
  if (!key) return null;
  const hits = options.filter(o => countryKey(o) === key);
  if (!hits.length) return null;
  // A code in the value ("United States +1") must agree with the option's, when both have one.
  const code = dialCode(v);
  const agreeing = code ? hits.filter(o => !dialCode(o) || dialCode(o) === code) : hits;
  return shortest(agreeing);
}

function shortest(xs: readonly string[]): string | null {
  let best: string | null = null;
  for (const x of xs) if (best === null || x.length < best.length) best = x;
  return best;
}
