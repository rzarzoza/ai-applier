import { conditionalGet } from "./http.js";
import { normalizeUrl } from "./normalize.js";
import type { Posting, SourceAdapter } from "./types.js";

type Cols = { company: number; role: number; location: number; apply: number; age: number };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e]);
}

function cleanText(cell: string): string {
  return decode(
    cell
      .replace(/<summary>.*?<\/summary>/gis, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}️‍]/gu, ""),
  ).replace(/\s+/g, " ").trim();
}

function cellLocations(cell: string): string[] {
  return cell
    .replace(/<summary>.*?<\/summary>/gis, "")
    .split(/<\/?br\s*\/?>/i)
    .map(cleanText)
    .filter(Boolean);
}

function findCols(headers: string[]): Cols | null {
  const idx = (re: RegExp) => headers.findIndex(h => re.test(h));
  const cols = {
    company: idx(/^company/i),
    role: idx(/^(role|position|title)/i),
    location: idx(/^location/i),
    apply: idx(/^(application|link|apply)/i),
    age: idx(/^(age|date)/i),
  };
  return cols.company >= 0 && cols.role >= 0 && cols.apply >= 0 ? cols : null;
}

function isSimplifyHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "simplify.jobs" || h.endsWith(".simplify.jobs");
  } catch {
    return false;
  }
}

function applyLink(cell: string): string | null {
  const hrefs = [
    ...[...cell.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]),
    ...[...cell.matchAll(/\]\(\s*<?(https?:[^)\s>]+)/g)].map(m => m[1]),
  ].map(decode);
  return hrefs.find(h => /^https?:/i.test(h) && !isSimplifyHost(h)) ?? null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseAge(text: string, now: Date): Date {
  const t = cleanText(text).toLowerCase();
  const rel = /^(\d+)\s*(h|d|w|mo|m|y)$/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(now);
    switch (rel[2]) {
      case "h": d.setUTCHours(d.getUTCHours() - n); break;
      case "d": d.setUTCDate(d.getUTCDate() - n); break;
      case "w": d.setUTCDate(d.getUTCDate() - 7 * n); break;
      case "mo": case "m": d.setUTCMonth(d.getUTCMonth() - n); break;
      case "y": d.setUTCFullYear(d.getUTCFullYear() - n); break;
    }
    return d;
  }
  const md = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/.exec(t);
  if (md && MONTHS.includes(md[1])) {
    return new Date(Date.UTC(now.getUTCFullYear(), MONTHS.indexOf(md[1]), Number(md[2])));
  }
  return new Date(now);
}

interface RowState { lastCompany: string }

function buildPosting(cells: string[], cols: Cols, sourceId: string, now: Date, state: RowState): Posting | null {
  const applyCell = cells[cols.apply] ?? "";
  let company = cleanText(cells[cols.company] ?? "");
  if (company === "" || company === "↳") company = state.lastCompany;
  else state.lastCompany = company;
  if (applyCell.includes("🔒")) return null;
  const url = applyLink(applyCell);
  const title = cleanText(cells[cols.role] ?? "");
  if (!url || !company || !title) return null;
  return {
    sourceId,
    listingId: normalizeUrl(url),
    company,
    title,
    locations: cols.location >= 0 ? cellLocations(cells[cols.location] ?? "") : [],
    category: null,
    terms: [],
    degrees: [],
    sponsorship: null,
    url,
    datePosted: cols.age >= 0 ? parseAge(cells[cols.age] ?? "", now) : new Date(now),
    active: true,
  };
}

function parseHtmlTables(text: string, sourceId: string, now: Date): Posting[] {
  const out: Posting[] = [];
  for (const table of text.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [...table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
    let cols: Cols | null = null;
    const state: RowState = { lastCompany: "" };
    for (const row of rows) {
      const ths = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => cleanText(m[1]));
      if (ths.length) { cols = findCols(ths); continue; }
      if (!cols) continue;
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
      const p = buildPosting(cells, cols, sourceId, now, state);
      if (p) out.push(p);
    }
  }
  return out;
}

const splitPipes = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function parsePipeTables(text: string, sourceId: string, now: Date): Posting[] {
  const out: Posting[] = [];
  const lines = text.split(/\r?\n/);
  let cols: Cols | null = null;
  const state: RowState = { lastCompany: "" };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) { cols = null; continue; }
    if (i + 1 < lines.length && isSeparator(lines[i + 1]) && !isSeparator(line)) {
      cols = findCols(splitPipes(line).map(cleanText));
      state.lastCompany = "";
      continue;
    }
    if (!cols || isSeparator(line)) continue;
    const p = buildPosting(splitPipes(line), cols, sourceId, now, state);
    if (p) out.push(p);
  }
  return out;
}

export function parseReadmeTable(text: string, sourceId: string, now: Date): Posting[] {
  return [...parseHtmlTables(text, sourceId, now), ...parsePipeTables(text, sourceId, now)];
}

export const readmeTableAdapter: SourceAdapter = {
  async fetch(cfg, fetchFn = fetch) {
    const res = await conditionalGet(cfg, fetchFn);
    if (res.notModified) return res;
    const postings = parseReadmeTable(res.body, cfg.id, new Date());
    if (postings.length === 0) throw new Error(`Source ${cfg.id}: no job table found in README`);
    return { notModified: false, etag: res.etag, postings };
  },
};
