import type { Db } from "../db/db.js";
import { getJob, isUnknownSubmission, setStatus } from "../jobs/repo.js";
import { approveAnswer, deleteQuestion, getQuestion, openNeedsYouForJob, type NeedsYou, type Question } from "./bank.js";

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

export interface InboxItem { question: Question; jobs: { id: string; company: string; title: string }[] }

/**
 * Questions (any status, including approved answers that didn't fit) that block at least one job
 * still waiting on the user, most-blocking first. Blockers of jobs that moved on (skipped, closed,
 * applied...) are not counted.
 */
export function inboxItems(db: Db): InboxItem[] {
  const ids = db.prepare(`SELECT q.id FROM questions q JOIN job_blockers b ON b.question_id = q.id
      JOIN jobs j ON j.id = b.job_id WHERE j.status = 'needs-you'
      GROUP BY q.id ORDER BY COUNT(*) DESC, q.id`).all() as unknown as { id: number }[];
  return ids.map(({ id }) => ({
    question: getQuestion(db, id)!,
    jobs: db.prepare(`SELECT j.id, j.company, j.title FROM job_blockers b JOIN jobs j ON j.id = b.job_id
        WHERE b.question_id = ? AND j.status = 'needs-you' ORDER BY j.rowid`).all(id) as unknown as InboxItem["jobs"],
  }));
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
