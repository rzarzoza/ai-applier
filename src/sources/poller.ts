import type { Db } from "../db/db.js";
import { evaluateFilters, getFilters } from "../filters/filters.js";
import { findLiveRole, setChosenLocation, setStatus, upsertPosting } from "../jobs/repo.js";
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

function processPostings(db: Db, sourceId: string, postings: Posting[], now: Date, report: PollReport): void {
  const rules = getFilters(db);
  const listed = new Set<string>();
  const close = (id: string, reason: string) => { setStatus(db, id, "closed", reason); report.closed++; };

  for (const p of postings) {
    listed.add(p.listingId);
    const { job, isNew } = upsertPosting(db, p);
    if (!isNew) {
      if (!p.active && CLOSABLE.includes(job.status)) close(job.id, "posting is no longer active");
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
  for (const j of open) if (!listed.has(j.listing_id)) close(j.id, "posting is no longer listed by the source");
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
