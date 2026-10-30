import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Resolution } from "../answers/resolve.js";
import type { Db } from "../db/db.js";
import type { FieldSpec } from "../forms/types.js";
import { paths } from "../paths.js";

const jobDir = (jobId: string) => path.join(paths.records, jobId);

/**
 * Writes the record of one submission to `RECORDS_DIR/<jobId>/<ISO time>/`: the screenshots in order
 * (`01.png`, `02.png`, ...) and `record.json` with the time, outcome and every answer sent.
 * Returns that directory.
 */
export function saveRecord(jobId: string, r: { screenshots: Buffer[]; answers: { label: string; value: unknown; source: string }[]; outcome: string }): string {
  const time = new Date().toISOString();
  const dir = path.join(jobDir(jobId), time);
  mkdirSync(dir, { recursive: true });
  r.screenshots.forEach((shot, i) => writeFileSync(path.join(dir, `${String(i + 1).padStart(2, "0")}.png`), shot));
  writeFileSync(path.join(dir, "record.json"), JSON.stringify({ time, outcome: r.outcome, answers: r.answers }, null, 2));
  return dir;
}

/** The job's record directories, oldest first. */
export function listRecords(jobId: string): string[] {
  let entries;
  try {
    entries = readdirSync(jobDir(jobId), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => e.isDirectory()).map(e => path.join(jobDir(jobId), e.name)).sort();
}

/**
 * Stores what the runner saw on the job's latest run (its fields, their resolutions, and a screenshot
 * saved as `RECORDS_DIR/<jobId>/snapshot-<ISO time>.png`), replacing the previous snapshot.
 */
export function saveSnapshot(db: Db, jobId: string, s: { fields: FieldSpec[]; resolutions: Resolution[]; screenshot: Buffer | null }): void {
  const time = new Date().toISOString();
  let shotPath: string | null = null;
  if (s.screenshot) {
    mkdirSync(jobDir(jobId), { recursive: true });
    shotPath = path.join(jobDir(jobId), `snapshot-${time}.png`);
    writeFileSync(shotPath, s.screenshot);
  }
  db.prepare(`INSERT OR REPLACE INTO job_snapshots (job_id, fields_json, resolutions_json, screenshot_path, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(jobId, JSON.stringify(s.fields), JSON.stringify(s.resolutions), shotPath, time);
}

export interface Snapshot { fields: FieldSpec[]; resolutions: Resolution[]; screenshotPath: string | null; createdAt: string }

/** The job's stored snapshot (see `saveSnapshot`), or null if the runner has not saved one. */
export function getSnapshot(db: Db, jobId: string): Snapshot | null {
  const r = db.prepare("SELECT * FROM job_snapshots WHERE job_id = ?").get(jobId) as
    { fields_json: string; resolutions_json: string; screenshot_path: string | null; created_at: string } | undefined;
  return r ? { fields: JSON.parse(r.fields_json) as FieldSpec[], resolutions: JSON.parse(r.resolutions_json) as Resolution[], screenshotPath: r.screenshot_path, createdAt: r.created_at } : null;
}
