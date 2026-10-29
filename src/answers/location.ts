/**
 * Places in answers and option lists ("Houston, Texas" vs "Houston, TX, USA"): plain functions with no dependencies, so
 * the browser extension can bundle them too.
 */
import type { FieldSpec } from "../forms/types.js";

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function yesNo(value: string): boolean | null {
  const v = norm(value);
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return null;
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

export type Place = { city: string; region: { name: string; code: string | null } | null; country: string | null };

/** "Houston, Texas" / "Houston, TX, USA" as city, region (state name and code when known) and country. */
export function parsePlace(value: string): Place | null {
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
export function placeMatches(place: Place, option: string): boolean {
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
