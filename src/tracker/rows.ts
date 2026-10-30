import { atsNameFromUrl } from "../ats/registry.js";
import type { Db } from "../db/db.js";

export const TRACKER_HEADERS = [
  "Date applied", "Company", "Job title", "Posting link", "Location", "Resume used", "Cover letter used", "Status", "Application system",
];

interface Row {
  company: string; title: string; url: string; chosen_location: string | null; resume_used: string | null;
  cover_letter_used: string | null; status: string; applied_at: string;
}

/** Local-time YYYY-MM-DD. */
function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One row per submitted or manually-applied job, newest first. Unknown values are empty strings. */
export function trackerRows(db: Db): string[][] {
  const rows = db.prepare(
    `SELECT company, title, url, chosen_location, resume_used, cover_letter_used, status,
            COALESCE(submitted_at, updated_at) AS applied_at
       FROM jobs WHERE status IN ('submitted', 'applied-manually')
      ORDER BY applied_at DESC, rowid DESC`,
  ).all() as unknown as Row[];
  return rows.map(r => [
    localDate(r.applied_at), r.company, r.title, r.url, r.chosen_location ?? "", r.resume_used ?? "", r.cover_letter_used ?? "",
    r.status, atsNameFromUrl(r.url),
  ]);
}
