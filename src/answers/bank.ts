import type { Db } from "../db/db.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";

export interface Question {
  id: number; canonical: string; kind: "global" | "template"; isFactual: boolean; answer: string | null;
  draft: string | null; status: "none" | "draft" | "approved"; options: string[] | null; useCount: number; variants: string[];
}

interface Row {
  id: number; canonical: string; kind: Question["kind"]; is_factual: number; answer: string | null;
  draft: string | null; status: Question["status"]; options: string | null; use_count: number;
}

function toQuestion(db: Db, r: Row): Question {
  const variants = (db.prepare("SELECT label FROM question_variants WHERE question_id = ? ORDER BY rowid").all(r.id) as unknown as { label: string }[]).map(v => v.label);
  return {
    id: r.id, canonical: r.canonical, kind: r.kind, isFactual: r.is_factual === 1, answer: r.answer, draft: r.draft,
    status: r.status, options: r.options ? (JSON.parse(r.options) as string[]) : null, useCount: r.use_count, variants,
  };
}

export function getQuestion(db: Db, id: number): Question | null {
  const r = db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
  return r ? toQuestion(db, r) : null;
}

export function createQuestion(db: Db, q: { canonical: string; kind: "global" | "template"; isFactual: boolean; options?: string[] | null; draft?: string | null }): Question {
  const res = db.prepare("INSERT INTO questions (canonical, kind, is_factual, draft, status, options) VALUES (?, ?, ?, ?, ?, ?)")
    .run(q.canonical, q.kind, q.isFactual ? 1 : 0, q.draft ?? null, q.draft ? "draft" : "none", q.options ? JSON.stringify(q.options) : null);
  return getQuestion(db, Number(res.lastInsertRowid))!;
}

export function listQuestions(db: Db, q: { status?: Question["status"]; search?: string } = {}): Question[] {
  const where: string[] = [];
  const args: string[] = [];
  if (q.status) { where.push("status = ?"); args.push(q.status); }
  if (q.search) {
    const like = `%${q.search.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(canonical LIKE ? ESCAPE '\\' OR id IN (SELECT question_id FROM question_variants WHERE label LIKE ? ESCAPE '\\'))");
    args.push(like, like);
  }
  const rows = db.prepare(`SELECT * FROM questions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`).all(...args) as unknown as Row[];
  return rows.map(r => toQuestion(db, r));
}

export function addVariant(db: Db, id: number, label: string): void {
  db.prepare("INSERT OR IGNORE INTO question_variants (question_id, label) VALUES (?, ?)").run(id, label);
}

export function setDraft(db: Db, id: number, text: string): void {
  db.prepare("UPDATE questions SET draft = ?, status = CASE WHEN status = 'approved' THEN status ELSE 'draft' END WHERE id = ?").run(text, id);
}

export function approveAnswer(db: Db, id: number, text: string, kind?: "global" | "template"): void {
  db.prepare("UPDATE questions SET answer = ?, status = 'approved', kind = COALESCE(?, kind) WHERE id = ?").run(text, kind ?? null, id);
}

export function deleteQuestion(db: Db, id: number): void {
  db.prepare("DELETE FROM questions WHERE id = ?").run(id);
}

export function incrementUse(db: Db, id: number): void {
  db.prepare("UPDATE questions SET use_count = use_count + 1 WHERE id = ?").run(id);
}

/** Records that the question blocks the job, with the blocking field's label, kind and options when known. */
export function addBlocker(db: Db, jobId: string, questionId: number, reason: "missing" | "approval", field?: Pick<FieldSpec, "label" | "kind" | "options">): void {
  db.prepare("INSERT OR REPLACE INTO job_blockers (job_id, question_id, reason, field_label, field_kind, options_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(jobId, questionId, reason, field?.label ?? null, field?.kind ?? null, field?.options?.length ? JSON.stringify(field.options) : null);
}

/** Removes every blocker recorded for the job (a new run records the ones that still apply). */
export function clearBlockersForJob(db: Db, jobId: string): void {
  db.prepare("DELETE FROM job_blockers WHERE job_id = ?").run(jobId);
}

export function blockersForJob(db: Db, jobId: string): { questionId: number; reason: string }[] {
  const rows = db.prepare("SELECT question_id, reason FROM job_blockers WHERE job_id = ? ORDER BY question_id").all(jobId) as unknown as { question_id: number; reason: string }[];
  return rows.map(r => ({ questionId: r.question_id, reason: r.reason }));
}

export interface NeedsYou { id: number; jobId: string; kind: "captcha" | "code" | "login" | "other"; message: string; createdAt: string }

export function addNeedsYou(db: Db, n: { jobId: string; kind: NeedsYou["kind"]; message: string }): number {
  const res = db.prepare("INSERT INTO needs_you (job_id, kind, message, created_at) VALUES (?, ?, ?, ?)")
    .run(n.jobId, n.kind, n.message, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

type NeedsYouRow = { id: number; job_id: string; kind: NeedsYou["kind"]; message: string; created_at: string };
const toNeedsYou = (r: NeedsYouRow): NeedsYou => ({ id: r.id, jobId: r.job_id, kind: r.kind, message: r.message, createdAt: r.created_at });

/** Open items of jobs still waiting on the user (status needs-you); items of jobs that moved on are not listed. */
export function listOpenNeedsYou(db: Db): NeedsYou[] {
  const rows = db.prepare(`SELECT n.* FROM needs_you n JOIN jobs j ON j.id = n.job_id
      WHERE n.resolved = 0 AND j.status = 'needs-you' ORDER BY n.id`).all() as unknown as NeedsYouRow[];
  return rows.map(toNeedsYou);
}

/** The job's open needs-you items, whatever its status. */
export function openNeedsYouForJob(db: Db, jobId: string): NeedsYou[] {
  const rows = db.prepare("SELECT * FROM needs_you WHERE job_id = ? AND resolved = 0 ORDER BY id").all(jobId) as unknown as NeedsYouRow[];
  return rows.map(toNeedsYou);
}

export function resolveNeedsYouForJob(db: Db, jobId: string): void {
  db.prepare("UPDATE needs_you SET resolved = 1 WHERE job_id = ? AND resolved = 0").run(jobId);
}

export function setOverride(db: Db, jobId: string, fieldLabel: string, answer: FieldAnswer): void {
  db.prepare("INSERT OR REPLACE INTO job_overrides (job_id, field_label, answer_json) VALUES (?, ?, ?)").run(jobId, fieldLabel, JSON.stringify(answer));
}

export function getOverrides(db: Db, jobId: string): Record<string, FieldAnswer> {
  const rows = db.prepare("SELECT field_label, answer_json FROM job_overrides WHERE job_id = ? ORDER BY rowid").all(jobId) as unknown as { field_label: string; answer_json: string }[];
  return Object.fromEntries(rows.map(r => [r.field_label, JSON.parse(r.answer_json) as FieldAnswer]));
}
