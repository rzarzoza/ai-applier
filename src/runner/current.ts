import type { Db } from "../db/db.js";
import { getJson, setJson } from "../settings.js";

/** The kv key holding the job the runner is working on right now (see `RunnerCurrent`). */
export const RUNNER_CURRENT_KEY = "runnerCurrent";

/**
 * What the runner is doing right now, shown on the dashboard's "Applying now" card. `mode` is the run's mode
 * ("auto", "interactive", "submit-reviewed" or "hand-finish"). `maybeSent` is set while a hand-finish run waits for the
 * user: false until something on the page may mean the form went out (a form post, a navigation), then true. Kept after
 * a crash, it tells startup whether the interrupted run may have sent the application (see flagInterruptedRuns).
 */
export interface RunnerCurrent { jobId: string; step: RunnerStep; startedAt: string; mode?: string; maybeSent?: boolean }

export const STEPS = [
  "Opening application", "Reading the form", "Working out answers", "Uploading resume", "Filling fields", "Checking answers",
  "Waiting for review gate", "Submitting", "Waiting for confirmation", "Waiting for you (CAPTCHA/code)",
  "Waiting for you to finish and submit",
] as const;
export type RunnerStep = (typeof STEPS)[number];

export function getRunnerCurrent(db: Db): RunnerCurrent | null {
  try {
    const v = getJson<RunnerCurrent | null>(db, RUNNER_CURRENT_KEY, null);
    return v && typeof v.jobId === "string" && typeof v.step === "string" && typeof v.startedAt === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Records the runner's current step. Best effort: a dashboard hint must never affect a run. */
export function setRunnerCurrent(db: Db, value: RunnerCurrent): void {
  try { setJson(db, RUNNER_CURRENT_KEY, value); } catch { /* ignored */ }
}

export function clearRunnerCurrent(db: Db): void {
  try { db.prepare("DELETE FROM kv WHERE key = ?").run(RUNNER_CURRENT_KEY); } catch { /* ignored */ }
}
