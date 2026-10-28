import type { Db } from "../db/db.js";
import { setStatus } from "../jobs/repo.js";
import { approveAnswer, getQuestion, type Question } from "./bank.js";

export interface InboxItem { question: Question; jobs: { id: string; company: string; title: string }[] }

/** Questions (any status, including approved answers that didn't fit) that block at least one job, most-blocking first. */
export function inboxItems(db: Db): InboxItem[] {
  const ids = db.prepare(`SELECT q.id FROM questions q JOIN job_blockers b ON b.question_id = q.id
      GROUP BY q.id ORDER BY COUNT(*) DESC, q.id`).all() as unknown as { id: number }[];
  return ids.map(({ id }) => ({
    question: getQuestion(db, id)!,
    jobs: db.prepare(`SELECT j.id, j.company, j.title FROM job_blockers b JOIN jobs j ON j.id = b.job_id
        WHERE b.question_id = ? ORDER BY j.rowid`).all(id) as unknown as InboxItem["jobs"],
  }));
}

/** Approves the answer, clears its blockers, and requeues needs-you jobs left with no blockers. */
export function answerQuestion(db: Db, questionId: number, text: string, kind?: "global" | "template"): { requeued: string[] } {
  approveAnswer(db, questionId, text, kind);
  const affected = (db.prepare("SELECT job_id FROM job_blockers WHERE question_id = ? ORDER BY rowid").all(questionId) as unknown as { job_id: string }[]).map(r => r.job_id);
  db.prepare("DELETE FROM job_blockers WHERE question_id = ?").run(questionId);
  const requeued: string[] = [];
  for (const id of affected) {
    const left = db.prepare(`SELECT (SELECT COUNT(*) FROM job_blockers WHERE job_id = ?) AS n, (SELECT status FROM jobs WHERE id = ?) AS status`)
      .get(id, id) as { n: number; status: string };
    if (left.n === 0 && left.status === "needs-you") { setStatus(db, id, "queued"); requeued.push(id); }
  }
  return { requeued };
}
