import { conditionalGet } from "./http.js";
import { normalizeUrl } from "./normalize.js";
import type { Posting, SourceAdapter } from "./types.js";

interface RawListing {
  id?: unknown;
  company_name?: unknown;
  title?: unknown;
  locations?: unknown;
  category?: unknown;
  terms?: unknown;
  degrees?: unknown;
  sponsorship?: unknown;
  url?: unknown;
  date_posted?: unknown;
  active?: unknown;
  is_visible?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function isSimplifyHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "simplify.jobs" || h.endsWith(".simplify.jobs");
  } catch {
    return false;
  }
}

export function parseSimplifyListings(json: unknown, sourceId: string): Posting[] {
  if (!Array.isArray(json)) throw new Error("listings.json: expected a top-level array");
  const out: Posting[] = [];
  for (const raw of json as RawListing[]) {
    if (!raw || raw.active !== true || raw.is_visible !== true) continue;
    if (typeof raw.url !== "string" || typeof raw.company_name !== "string" || typeof raw.title !== "string") continue;
    if (isSimplifyHost(raw.url)) continue;
    const seconds = typeof raw.date_posted === "number" ? raw.date_posted : null;
    out.push({
      sourceId,
      listingId: normalizeUrl(raw.url),
      company: raw.company_name,
      title: raw.title,
      locations: strings(raw.locations),
      category: typeof raw.category === "string" ? raw.category : null,
      terms: strings(raw.terms),
      degrees: strings(raw.degrees),
      sponsorship: typeof raw.sponsorship === "string" ? raw.sponsorship : null,
      url: raw.url,
      datePosted: seconds !== null ? new Date(seconds * 1000) : new Date(),
      active: true,
    });
  }
  return out;
}

export const simplifyAdapter: SourceAdapter = {
  async fetch(cfg, fetchFn = fetch) {
    const res = await conditionalGet(cfg, fetchFn);
    if (res.notModified) return res;
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error(`Source ${cfg.id}: response is not valid JSON`);
    }
    return { notModified: false, etag: res.etag, postings: parseSimplifyListings(json, cfg.id) };
  },
};
