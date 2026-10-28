import type { Db } from "../db/db.js";
import { getJob, isUnknownSubmission, RESUME_NEEDED, setStatus } from "../jobs/repo.js";
import type { FieldKind } from "../forms/types.js";
import { approveAnswer, deleteQuestion, getQuestion, openNeedsYouForJob, resolveNeedsYouForJob, setOverride, type NeedsYou, type Question } from "./bank.js";

/** After a resume upload: requeues the jobs that were waiting for one. Returns their ids. */
export function requeueWaitingForResume(db: Db): string[] {
  const ids = (db.prepare("SELECT id FROM jobs WHERE status = 'needs-you' AND status_reason = ? ORDER BY rowid").all(RESUME_NEEDED) as unknown as { id: string }[]).map(r => r.id);
  for (const id of ids) {
    resolveNeedsYouForJob(db, id);
    setStatus(db, id, "queued");
  }
  return ids;
}

/** Needs-you kinds the user clears at the browser, so "Do it now" may open the form for them. */
const AT_THE_BROWSER: ReadonlySet<NeedsYou["kind"]> = new Set(["captcha", "code", "login"]);

/**
 * Whether "Do it now" may re-open the job's form: it is waiting on the user for a CAPTCHA, code or
 * login, and its application was not possibly sent already (that needs the confirmed Retry instead).
 */
export function canDoItNow(db: Db, jobId: string): boolean {
  const job = getJob(db, jobId);
  if (!job || job.status !== "needs-you" || isUnknownSubmission(job)) return false;
  return openNeedsYouForJob(db, jobId).some(n => AT_THE_BROWSER.has(n.kind));
}

/** A job a question blocks, with the blocking field (label and kind are null on blockers stored before they were recorded). */
export interface BlockedJob {
  id: string; company: string; title: string; label: string | null; kind: FieldKind | null; options: string[] | null;
}
export interface InboxItem { question: Question; jobs: BlockedJob[] }

type BlockerRow = { id: string; company: string; title: string; label: string | null; kind: FieldKind | null; options_json: string | null };
const toBlocked = (r: BlockerRow): BlockedJob =>
  ({ id: r.id, company: r.company, title: r.title, label: r.label, kind: r.kind, options: r.options_json ? (JSON.parse(r.options_json) as string[]) : null });

/** The jobs still waiting on the user (needs-you) that the question blocks. */
function blockedJobsOf(db: Db, questionId: number): BlockedJob[] {
  const rows = db.prepare(`SELECT j.id, j.company, j.title, b.field_label AS label, b.field_kind AS kind, b.options_json
      FROM job_blockers b JOIN jobs j ON j.id = b.job_id
      WHERE b.question_id = ? AND j.status = 'needs-you' ORDER BY j.rowid`).all(questionId) as unknown as BlockerRow[];
  return rows.map(toBlocked);
}

/**
 * Questions (any status, including approved answers that didn't fit) that block at least one job
 * still waiting on the user, most-blocking first. Blockers of jobs that moved on (skipped, closed,
 * applied...) are not counted.
 */
export function inboxItems(db: Db): InboxItem[] {
  const ids = db.prepare(`SELECT q.id FROM questions q JOIN job_blockers b ON b.question_id = q.id
      JOIN jobs j ON j.id = b.job_id WHERE j.status = 'needs-you'
      GROUP BY q.id ORDER BY COUNT(*) DESC, q.id`).all() as unknown as { id: number }[];
  return ids.map(({ id }) => ({ question: getQuestion(db, id)!, jobs: blockedJobsOf(db, id) }));
}

/** The options of the field blocking the job (the question's own options for blockers stored without the field). */
export function blockerOptions(q: Question, b: BlockedJob): string[] | null {
  return b.label === null ? q.options : b.options;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const fits = (options: string[] | null, answer: string) => !options || options.some(o => sameText(o, answer));

/**
 * Answers a question from the inbox. `choices` picks an option for one job's form (by job id): it is
 * saved as that job's override, leaving the bank answer alone. `text` is the answer for the rest:
 * it becomes the bank answer, except when the question already has a saved answer that none of the
 * remaining forms offer as an option, where `text` is saved per job instead of overwriting it.
 * Requeues needs-you jobs left with nothing blocking them.
 */
export function answerFromInbox(db: Db, questionId: number, input: { text: string; kind?: "global" | "template"; choices?: Record<string, string> }):
  { requeued: string[] } | { error: string } {
  const q = getQuestion(db, questionId);
  if (!q) return { error: "Unknown question" };
  // Decided on the jobs the card showed (still waiting); approving still clears every blocker of the question.
  const blockers = blockedJobsOf(db, questionId);
  const pickFor = (b: BlockedJob, value: string) => (b.label ? blockerOptions(q, b)?.find(o => sameText(o, value)) : undefined);

  const chosen = Object.entries(input.choices ?? {}).filter(([, v]) => v.trim());
  const picks: [BlockedJob, string][] = [];
  for (const [jobId, value] of chosen) {
    const b = blockers.find(x => x.id === jobId);
    const pick = b && pickFor(b, value);
    if (!b || pick === undefined) return { error: "That is not one of the options for that job." };
    picks.push([b, pick]);
  }
  if (!input.text && !picks.length) return { error: "Type an answer first." };

  const saveForJob = (b: BlockedJob, pick: string) => {
    setOverride(db, b.id, b.label!, b.kind === "checkbox-group" ? { type: "options", options: [pick] } : { type: "option", option: pick });
    db.prepare("DELETE FROM job_blockers WHERE job_id = ? AND question_id = ?").run(b.id, questionId);
  };
  for (const [b, pick] of picks) saveForJob(b, pick);

  const rest = blockers.filter(b => !picks.some(([p]) => p.id === b.id));
  if (input.text) {
    const saved = q.status === "approved" ? q.answer : null;
    const keepSaved = saved !== null && rest.length > 0 &&
      rest.every(b => blockerOptions(q, b) !== null && !fits(blockerOptions(q, b), saved) && pickFor(b, input.text) !== undefined);
    if (keepSaved) for (const b of rest) saveForJob(b, pickFor(b, input.text)!);
    else {
      approveAnswer(db, questionId, input.text, input.kind);
      db.prepare("DELETE FROM job_blockers WHERE question_id = ?").run(questionId);
    }
  }
  return { requeued: requeueUnblocked(db, blockers.map(b => b.id)) };
}

/** Approves the answer, clears its blockers, and requeues needs-you jobs left with nothing blocking them. */
export function answerQuestion(db: Db, questionId: number, text: string, kind?: "global" | "template"): { requeued: string[] } {
  approveAnswer(db, questionId, text, kind);
  const affected = blockedJobs(db, questionId);
  db.prepare("DELETE FROM job_blockers WHERE question_id = ?").run(questionId);
  return { requeued: requeueUnblocked(db, affected) };
}

/** Deletes the question (and its blockers), and requeues needs-you jobs it alone was blocking. */
export function deleteQuestionAndRequeue(db: Db, questionId: number): { requeued: string[] } {
  const affected = blockedJobs(db, questionId);
  deleteQuestion(db, questionId);
  return { requeued: requeueUnblocked(db, affected) };
}

const blockedJobs = (db: Db, questionId: number) =>
  (db.prepare("SELECT job_id FROM job_blockers WHERE question_id = ? ORDER BY rowid").all(questionId) as unknown as { job_id: string }[]).map(r => r.job_id);

/** Requeues each job that is in needs-you with no blockers and no open needs-you item left. */
function requeueUnblocked(db: Db, jobIds: string[]): string[] {
  const requeued: string[] = [];
  for (const id of jobIds) {
    const left = db.prepare("SELECT COUNT(*) AS n FROM job_blockers WHERE job_id = ?").get(id) as { n: number };
    if (left.n === 0 && getJob(db, id)?.status === "needs-you" && openNeedsYouForJob(db, id).length === 0) {
      setStatus(db, id, "queued");
      requeued.push(id);
    }
  }
  return requeued;
}
