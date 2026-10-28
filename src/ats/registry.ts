import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import type { AtsHandler } from "./types.js";

export const HANDLERS: AtsHandler[] = [greenhouse, lever];

export function detectAts(url: string, handlers: AtsHandler[] = HANDLERS): AtsHandler | null {
  return handlers.find(h => h.matches(url)) ?? null;
}

export type AtsName = "workday" | "greenhouse" | "lever" | "ashby" | "oracle" | "smartrecruiters" | "other";

const BY_HOST: [RegExp, AtsName][] = [
  [/(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/, "workday"],
  [/(^|\.)greenhouse\.io$/, "greenhouse"],
  [/(^|\.)lever\.co$/, "lever"],
  [/(^|\.)ashbyhq\.com$/, "ashby"],
  [/(^|\.)oraclecloud\.com$/, "oracle"],
  [/(^|\.)smartrecruiters\.com$/, "smartrecruiters"],
];

/** The ATS behind a posting URL, for display and stats (independent of which handlers exist). */
export function atsNameFromUrl(url: string): AtsName {
  let u: URL;
  try { u = new URL(url); } catch { return "other"; }
  if (u.searchParams.has("gh_jid")) return "greenhouse";
  return BY_HOST.find(([re]) => re.test(u.hostname))?.[1] ?? "other";
}
