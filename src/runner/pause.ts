import { resolveNeedsYouForJob } from "../answers/bank.js";
import type { Db } from "../db/db.js";
import { PAUSED_MID_RUN, setStatus } from "../jobs/repo.js";
import { clearRunnerHalt, saveSettings } from "../settings.js";

/**
 * Pauses the runner: it takes no new job, and the job it is running stops cleanly at its next check (between two fields
 * or before submitting), parked as needs-you (PAUSED_MID_RUN) with what it filled so far.
 */
export function pauseRunner(db: Db): void {
  saveSettings(db, { paused: true });
}

/**
 * Resumes the runner: clears any halt reason and queues again every job a pause stopped mid-run (their parked tabs are
 * closed by the sweep, and the next run fills them afresh). Returns the ids queued again.
 */
export function resumeRunner(db: Db): string[] {
  saveSettings(db, { paused: false });
  clearRunnerHalt(db);
  const ids = (db.prepare("SELECT id FROM jobs WHERE status = 'needs-you' AND status_reason = ? ORDER BY rowid").all(PAUSED_MID_RUN) as { id: string }[])
    .map(r => r.id);
  for (const id of ids) {
    resolveNeedsYouForJob(db, id);
    setStatus(db, id, "queued");
  }
  return ids;
}
