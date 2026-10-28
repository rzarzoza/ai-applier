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
  role_key: string; attempts: number; submitted_at: string | null; updated_at: string; degrees: string | null;
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
    degrees: r.degrees === null ? null : (JSON.parse(r.degrees) as string[]),
    attempts: r.attempts, submittedAt: r.submitted_at ? new Date(r.submitted_at) : null,
    updatedAt: new Date(r.updated_at),
  };
}

const touch = () => new Date().toISOString();

/** The reason of a job the user skipped (filters never bring it back). */
export const SKIPPED_BY_YOU = "Skipped by you";

/** The needs-you reason for a job whose form needs a resume file and none is uploaded. */
export const RESUME_NEEDED = "Upload your resume in Profile";

/** The needs-you reason for a job whose application may already have gone out. */
export const UNKNOWN_SUBMISSION = "Submission state unknown — check before retrying";
export const UNKNOWN_SUBMISSION_PREFIX = "Submission state unknown";
/**
 * The needs-you reason of a job the user finished by hand ("Open & finish") whose page never confirmed the submission
 * although the form may have been sent. It counts as a possibly sent application, like UNKNOWN_SUBMISSION.
 */
export const HAND_UNCONFIRMED = "Finished by hand? Not confirmed — check before retrying";
/** Its application may have been sent: never re-run it without the user confirming it wasn't. */
export const isUnknownSubmission = (j: Job) =>
  j.status === "needs-you" && (!!j.statusReason?.startsWith(UNKNOWN_SUBMISSION_PREFIX) || j.statusReason === HAND_UNCONFIRMED);

export function getJob(db: Db, id: string): Job | null {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return r ? toJob(r) : null;
}

/**
 * Inserts the posting as status "new", or refreshes `active` (and fills in missing degrees) on the
 * existing job, matched by source+listing or url.
 */
export function upsertPosting(db: Db, p: Posting): { job: Job; isNew: boolean } {
  const urlNorm = normalizeUrl(p.url);
  const existing = db.prepare("SELECT * FROM jobs WHERE (source_id = ? AND listing_id = ?) OR url_norm = ? ORDER BY (source_id = ? AND listing_id = ?) DESC LIMIT 1")
    .get(p.sourceId, p.listingId, urlNorm, p.sourceId, p.listingId) as Row | undefined;
  if (existing) {
    if ((existing.active === 1) !== p.active)
      db.prepare("UPDATE jobs SET active = ?, updated_at = ? WHERE id = ?").run(p.active ? 1 : 0, touch(), existing.id);
    if (existing.degrees === null) db.prepare("UPDATE jobs SET degrees = ? WHERE id = ?").run(JSON.stringify(p.degrees), existing.id);
    return { job: getJob(db, existing.id)!, isNew: false };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO jobs (id, source_id, listing_id, company, title, locations, category, terms, url, url_norm,
      date_posted, active, status, role_key, updated_at, degrees) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`)
    .run(id, p.sourceId, p.listingId, p.company, p.title, JSON.stringify(p.locations), p.category,
      JSON.stringify(p.terms), p.url, urlNorm, p.datePosted.toISOString(), p.active ? 1 : 0,
      roleKey(p.company, p.title, p.terms), touch(), JSON.stringify(p.degrees));
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

/** Undoes `incrementAttempts` for a run that never got to try (the runner was halted). */
export function decrementAttempts(db: Db, id: string): void {
  db.prepare("UPDATE jobs SET attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?").run(touch(), id);
}

/** The runner's order for queued jobs: newest posting first. */
const QUEUE_ORDER = "ORDER BY date_posted DESC, rowid ASC";

export function nextQueued(db: Db): Job | null {
  const r = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ${QUEUE_ORDER} LIMIT 1`).get() as Row | undefined;
  return r ? toJob(r) : null;
}

/** The next `limit` queued jobs, in the order the runner takes them. */
export function upNext(db: Db, limit: number): Job[] {
  return (db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ${QUEUE_ORDER} LIMIT ?`).all(limit) as unknown as Row[]).map(toJob);
}

/** Jobs in the status, most recently changed first. */
export function recentWithStatus(db: Db, status: JobStatus, limit: number): Job[] {
  const order = status === "submitted" ? "submitted_at DESC, updated_at DESC" : "updated_at DESC";
  return (db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY ${order}, rowid DESC LIMIT ?`).all(status, limit) as unknown as Row[]).map(toJob);
}

/** Jobs set aside as duplicates of the role, still listed by their source, oldest first. */
export function activeDuplicatesOf(db: Db, key: string): Job[] {
  const rows = db.prepare("SELECT * FROM jobs WHERE role_key = ? AND status = 'duplicate-role' AND active = 1 ORDER BY rowid").all(key) as unknown as Row[];
  return rows.map(toJob);
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

/** Whether an application to the company went out: submitted, applied manually, or possibly sent (state unknown). */
export function hasSubmittedToCompany(db: Db, company: string): boolean {
  const r = db.prepare(`SELECT 1 AS x FROM jobs WHERE lower(company) = lower(?) AND (status IN ('submitted', 'applied-manually')
      OR (status = 'needs-you' AND (substr(status_reason, 1, ?) = ? OR status_reason = ?))) LIMIT 1`)
    .get(company, UNKNOWN_SUBMISSION_PREFIX.length, UNKNOWN_SUBMISSION_PREFIX, HAND_UNCONFIRMED);
  return r !== undefined;
}
