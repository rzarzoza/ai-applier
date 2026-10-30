import type { Db } from "../db/db.js";
import { evaluateFilters, getFilters, type FilterRules } from "../filters/filters.js";
import { activeDuplicatesOf, findLiveRole, getJob, listJobs, setChosenLocation, setStatus, SKIPPED_BY_YOU, upsertPosting } from "../jobs/repo.js";
import type { Job } from "../jobs/types.js";
import { listSources, markPolled } from "./repo.js";
import type { Posting, SourceAdapter, SourceConfig } from "./types.js";

export interface PollReport {
  sourceId: string; fetched: number; newJobs: number; queued: number; skipped: number; duplicates: number;
  closed: number; error?: string;
}

export interface PollDeps {
  adapters: Record<SourceConfig["kind"], SourceAdapter>;
  now: Date;
  fetchFn?: typeof fetch;
}

/** Statuses a poll may close; anything further along (submitted, failed, ...) is never touched. */
const CLOSABLE = ["queued", "needs-you", "ready-to-review"];

/** The posting a job was stored from, for checking it against the filters again. */
export function jobPosting(job: Job): Posting {
  return {
    sourceId: job.sourceId, listingId: job.listingId, company: job.company, title: job.title, locations: job.locations,
    category: job.category, terms: job.terms, degrees: job.degrees ?? [], sponsorship: null, url: job.url,
    datePosted: job.datePosted, active: job.active,
  };
}

/**
 * Checks a queued job against the current filters: one that no longer passes is skipped with the
 * reason; one that passes keeps (or gets) the location the filters choose. Returns whether it passes.
 * Posting age is an intake rule only: a job queued in time never ages out of the queue.
 */
export function recheckQueued(db: Db, job: Job, rules: FilterRules, now: Date): boolean {
  const result = evaluateFilters(jobPosting(job), { ...rules, postedWithinDays: null }, now);
  if (!result.pass) { setStatus(db, job.id, "skipped", result.reason); return false; }
  if (job.chosenLocation !== result.location) setChosenLocation(db, job.id, result.location);
  return true;
}

/**
 * Queues a job that passes the filters, unless another job is already live for the same role
 * (then it is a duplicate). Returns the status it was given.
 */
function queueIfPassing(db: Db, job: Job, rules: FilterRules, now: Date): "queued" | "skipped" | "duplicate-role" {
  const result = evaluateFilters(jobPosting(job), rules, now);
  if (!result.pass) { setStatus(db, job.id, "skipped", result.reason); return "skipped"; }
  const twin = findLiveRole(db, job.roleKey, job.id);
  if (twin) { setStatus(db, job.id, "duplicate-role", `same role as job ${twin.id}`); return "duplicate-role"; }
  setChosenLocation(db, job.id, result.location);
  setStatus(db, job.id, "queued");
  return "queued";
}

/**
 * Applies changed filters to existing jobs: queued jobs that no longer pass are skipped (posting age
 * aside, see `recheckQueued`), and jobs the
 * filters skipped before they ever ran are queued if they now pass (never ones the user skipped, nor
 * ones whose degree requirements weren't recorded while a degree rule is set).
 */
export function refilterJobs(db: Db, now: Date): { skipped: number; requeued: number } {
  const rules = getFilters(db);
  let skipped = 0;
  let requeued = 0;
  for (const job of listJobs(db, { status: "queued" })) if (!recheckQueued(db, job, rules, now)) skipped++;
  for (const job of listJobs(db, { status: "skipped" })) {
    if (job.attempts > 0 || job.statusReason === SKIPPED_BY_YOU || !job.active) continue;
    if (job.degrees === null && rules.degrees.length > 0) continue;
    if (!evaluateFilters(jobPosting(job), rules, now).pass) continue;
    if (queueIfPassing(db, job, rules, now) === "queued") requeued++;
  }
  return { skipped, requeued };
}

/** After a job closes, the first still-listed duplicate of its role that passes the filters takes its place. */
function promoteDuplicate(db: Db, closed: Job, rules: FilterRules, now: Date): boolean {
  if (findLiveRole(db, closed.roleKey, closed.id)) return false; // another job still covers the role
  return activeDuplicatesOf(db, closed.roleKey).some(twin => queueIfPassing(db, twin, rules, now) === "queued");
}

function processPostings(db: Db, sourceId: string, postings: Posting[], now: Date, report: PollReport): void {
  const rules = getFilters(db);
  const listed = new Set<string>();
  const close = (job: Job, reason: string) => {
    setStatus(db, job.id, "closed", reason);
    report.closed++;
    if (promoteDuplicate(db, job, rules, now)) report.queued++;
  };

  for (const p of postings) {
    listed.add(p.listingId);
    const { job, isNew } = upsertPosting(db, p);
    listed.add(job.listingId);
    if (!isNew) {
      if (!p.active && CLOSABLE.includes(job.status)) close(job, "posting is no longer active");
      continue;
    }
    report.newJobs++;
    if (!p.active) { setStatus(db, job.id, "closed", "posting is not active"); continue; }
    const result = evaluateFilters(p, rules, now);
    if (!result.pass) { setStatus(db, job.id, "skipped", result.reason); report.skipped++; continue; }
    const twin = findLiveRole(db, job.roleKey, job.id);
    if (twin) { setStatus(db, job.id, "duplicate-role", `same role as job ${twin.id}`); report.duplicates++; continue; }
    setChosenLocation(db, job.id, result.location);
    setStatus(db, job.id, "queued");
    report.queued++;
  }

  const open = db.prepare(`SELECT id, listing_id FROM jobs WHERE source_id = ? AND status IN (${CLOSABLE.map(() => "?").join(",")})`)
    .all(sourceId, ...CLOSABLE) as unknown as { id: string; listing_id: string }[];
  for (const j of open) if (!listed.has(j.listing_id)) close(getJob(db, j.id)!, "posting is no longer listed by the source");
}

export async function pollAll(db: Db, deps: PollDeps): Promise<PollReport[]> {
  const reports: PollReport[] = [];
  for (const cfg of listSources(db).filter(s => s.enabled)) {
    const report: PollReport = { sourceId: cfg.id, fetched: 0, newJobs: 0, queued: 0, skipped: 0, duplicates: 0, closed: 0 };
    reports.push(report);
    try {
      const res = await deps.adapters[cfg.kind].fetch(cfg, deps.fetchFn);
      if (res.notModified) { markPolled(db, cfg.id, cfg.etag, deps.now); continue; }
      report.fetched = res.postings.length;
      if (res.postings.length === 0) {
        report.error = "source returned 0 postings; skipped closing";
        continue;
      }
      db.exec("BEGIN");
      try {
        processPostings(db, cfg.id, res.postings, deps.now, report);
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
      markPolled(db, cfg.id, res.etag, deps.now);
    } catch (err) {
      Object.assign(report, { fetched: 0, newJobs: 0, queued: 0, skipped: 0, duplicates: 0, closed: 0 });
      report.error = err instanceof Error ? err.message : String(err);
    }
  }
  return reports;
}
