import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { normalizeUrl } from "../sources/normalize.js";
import type { Posting } from "../sources/types.js";
import { roleKey } from "./role-key.js";
import type { Job, JobStatus } from "./types.js";

interface Row {
  id: string; source_id: string; listing_id: string; company: string; title: string; locations: string;
  chosen_location: string | null; category: string | null; terms: string; url: string; url_norm: string;
  date_posted: string; active: number; status: JobStatus; status_reason: string | null; ats: string | null;
  role_key: string; attempts: number; submitted_at: string | null; updated_at: string;
}

const ALL_STATUSES: JobStatus[] = [
  "new", "skipped", "duplicate-role", "queued", "filling", "needs-you", "ready-to-review",
  "submitted", "failed", "closed", "unsupported", "applied-manually",
];

function toJob(r: Row): Job {
  return {
    id: r.id, sourceId: r.source_id, listingId: r.listing_id, company: r.company, title: r.title,
    locations: JSON.parse(r.locations) as string[], chosenLocation: r.chosen_location, category: r.category,
    terms: JSON.parse(r.terms) as string[], url: r.url, urlNorm: r.url_norm, datePosted: new Date(r.date_posted),
    active: r.active === 1, status: r.status, statusReason: r.status_reason, ats: r.ats, roleKey: r.role_key,
    attempts: r.attempts, submittedAt: r.submitted_at ? new Date(r.submitted_at) : null,
    updatedAt: new Date(r.updated_at),
  };
}

const touch = () => new Date().toISOString();

export function getJob(db: Db, id: string): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return r ? toJob(r) : null;
}

/** Inserts the posting as status "new", or refreshes `active` on the existing job (matched by source+listing or url). */
export function upsertPosting(db: Db, p: Posting): { job: Job; isNew: boolean } {
  const urlNorm = normalizeUrl(p.url);
  const existing = db.prepare("SELECT * FROM jobs WHERE (source_id = ? AND listing_id = ?) OR url_norm = ? ORDER BY (source_id = ? AND listing_id = ?) DESC LIMIT 1")
    .get(p.sourceId, p.listingId, urlNorm, p.sourceId, p.listingId) as Row | undefined;
  if (existing) {
    if ((existing.active === 1) !== p.active)
      db.prepare("UPDATE jobs SET active = ?, updated_at = ? WHERE id = ?").run(p.active ? 1 : 0, touch(), existing.id);
    return { job: getJob(db, existing.id)!, isNew: false };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO jobs (id, source_id, listing_id, company, title, locations, category, terms, url, url_norm,
      date_posted, active, status, role_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
    .run(id, p.sourceId, p.listingId, p.company, p.title, JSON.stringify(p.locations), p.category,
      JSON.stringify(p.terms), p.url, urlNorm, p.datePosted.toISOString(), p.active ? 1 : 0,
      roleKey(p.company, p.title, p.terms), touch());
  return { job: getJob(db, id)!, isNew: true };
}

export function listJobs(db: Db, q: { status?: JobStatus; limit?: number; offset?: number }): Job[] {
  const where = q.status ? "WHERE status = ?" : "";
  const args = q.status ? [q.status] : [];
  const rows = db.prepare(`SELECT * FROM jobs ${where} ORDER BY date_posted DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...args, q.limit ?? -1, q.offset ?? 0) as unknown as Row[];
  return rows.map(toJob);
}

export function countByStatus(db: Db): Record<JobStatus, number> {
  const counts = Object.fromEntries(ALL_STATUSES.map(s => [s, 0])) as Record<JobStatus, number>;
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as unknown as { status: JobStatus; n: number }[];
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export function setStatus(db: Db, id: string, status: JobStatus, reason: string | null = null): void {
  const submittedAt = status === "submitted" ? touch() : null;
  db.prepare("UPDATE jobs SET status = ?, status_reason = ?, submitted_at = COALESCE(?, submitted_at), updated_at = ? WHERE id = ?")
    .run(status, reason, submittedAt, touch(), id);
}

/** Records which resume and cover letter a submitted application used (shown in the tracker). */
export function setUsedDocuments(db: Db, id: string, resume: string | null, coverLetter: string): void {
  db.prepare("UPDATE jobs SET resume_used = ?, cover_letter_used = ?, updated_at = ? WHERE id = ?").run(resume, coverLetter, touch(), id);
}

export function setChosenLocation(db: Db, id: string, loc: string | null): void {
  db.prepare("UPDATE jobs SET chosen_location = ?, updated_at = ? WHERE id = ?").run(loc, touch(), id);
}

export function setAts(db: Db, id: string, ats: string): void {
  db.prepare("UPDATE jobs SET ats = ?, updated_at = ? WHERE id = ?").run(ats, touch(), id);
}

export function incrementAttempts(db: Db, id: string): void {
  db.prepare("UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(touch(), id);
}

export function nextQueued(db: Db): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY date_posted DESC, rowid ASC LIMIT 1").get() as Row | undefined;
  return r ? toJob(r) : null;
}

export function findLiveRole(db: Db, key: string, excludeId: string): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE role_key = ? AND id != ? AND status NOT IN ('skipped', 'closed', 'duplicate-role') ORDER BY rowid LIMIT 1")
    .get(key, excludeId) as Row | undefined;
  return r ? toJob(r) : null;
}

export function submittedSince(db: Db, since: Date): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'submitted' AND submitted_at >= ?").get(since.toISOString()) as { n: number };
  return r.n;
}

export function hasSubmittedToCompany(db: Db, company: string): boolean {
  const r = db.prepare("SELECT 1 AS x FROM jobs WHERE status = 'submitted' AND lower(company) = lower(?) LIMIT 1").get(company);
  return r !== undefined;
}
