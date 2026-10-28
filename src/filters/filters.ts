import type { Db } from "../db/db.js";
import { getJson, setJson } from "../settings.js";
import type { Posting } from "../sources/types.js";
import { inferCountry } from "./country.js";

export interface FilterRules {
  categories: string[];
  includeCountries: string[];
  excludeCountries: string[];
  includeLocations: string[];
  excludeLocations: string[];
  locationMode: "any" | "all";
  postedWithinDays: number | null;
  excludeCompanies: string[];
  titleRequire: string[];
  titleBlock: string[];
  degrees: string[];
}

export const DEFAULT_FILTERS: FilterRules = {
  categories: ["Software", "Software Engineering"],
  includeCountries: [],
  excludeCountries: ["Canada"],
  includeLocations: [],
  excludeLocations: [],
  locationMode: "any",
  postedWithinDays: 14,
  excludeCompanies: [],
  titleRequire: [],
  titleBlock: [],
  degrees: [],
};

export type FilterResult = { pass: true; location: string } | { pass: false; reason: string };

const DAY_MS = 86_400_000;
const hasAny = (text: string, needles: string[]) => {
  const t = text.toLowerCase();
  return needles.some((n) => t.includes(n.toLowerCase()));
};

/** Returns null if the location passes, else the reason it was rejected. */
function locationRejection(loc: string, r: FilterRules): string | null {
  const country = inferCountry(loc);
  if (r.excludeCountries.includes(country)) return `location "${loc}" is in excluded country ${country}`;
  if (r.includeCountries.length > 0 && !r.includeCountries.includes(country))
    return `location "${loc}" (${country}) is not in included countries`;
  if (hasAny(loc, r.excludeLocations)) return `location "${loc}" matches an excluded location`;
  if (r.includeLocations.length > 0 && !hasAny(loc, r.includeLocations))
    return `location "${loc}" matches no included location`;
  return null;
}

export function evaluateFilters(p: Posting, rules: FilterRules, now: Date): FilterResult {
  const fail = (reason: string): FilterResult => ({ pass: false, reason });

  if (rules.categories.length > 0 && !(p.category !== null && rules.categories.includes(p.category)))
    return fail(`category ${p.category ?? "none"} not in allowed categories`);
  if (rules.postedWithinDays !== null && now.getTime() - p.datePosted.getTime() > rules.postedWithinDays * DAY_MS)
    return fail(`posted more than ${rules.postedWithinDays} days ago`);
  if (hasAny(p.company, rules.excludeCompanies)) return fail(`company ${p.company} is excluded`);
  if (rules.titleRequire.length > 0 && !hasAny(p.title, rules.titleRequire))
    return fail("title lacks a required keyword");
  if (hasAny(p.title, rules.titleBlock)) return fail("title contains a blocked keyword");
  if (rules.degrees.length > 0 && p.degrees.length > 0 && !p.degrees.some((d) => rules.degrees.includes(d)))
    return fail("degree requirements do not match");

  if (p.locations.length === 0) return fail("posting has no locations");
  const rejections: string[] = [];
  const passing: string[] = [];
  for (const loc of p.locations) {
    const why = locationRejection(loc, rules);
    if (why) rejections.push(why);
    else passing.push(loc);
  }
  if (rules.locationMode === "all" ? rejections.length > 0 : passing.length === 0)
    return fail(rejections[0]!);
  return { pass: true, location: passing[0]! };
}

const FILTERS_KEY = "filters";

export function getFilters(db: Db): FilterRules {
  return { ...DEFAULT_FILTERS, ...getJson<Partial<FilterRules>>(db, FILTERS_KEY, {}) };
}

export function saveFilters(db: Db, rules: FilterRules): void {
  setJson(db, FILTERS_KEY, rules);
}
