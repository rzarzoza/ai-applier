import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { upsertPosting, getJob, setStatus } from "../../src/jobs/repo.js";
import type { Posting } from "../../src/sources/types.js";
import { addBlocker, addNeedsYou, addVariant, approveAnswer, blockersForJob, clearBlockersForJob, createQuestion, deleteQuestion, getOverrides, getQuestion, incrementUse, listOpenNeedsYou, listQuestions, resolveNeedsYouForJob, setDraft, setOverride } from "../../src/answers/bank.js";
import { answerQuestion, inboxItems } from "../../src/answers/inbox.js";

const p = (n: number): Posting => ({ sourceId: "s", listingId: String(n), company: `Co${n}`, title: "Intern", locations: ["NYC"],
  category: null, terms: [], degrees: [], sponsorship: null, url: `https://x.test/${n}`, datePosted: new Date("2026-10-20"), active: true });
const mkJob = (db: ReturnType<typeof openDb>, n: number) => { const j = upsertPosting(db, p(n)).job; setStatus(db, j.id, "needs-you"); return j; };
const q = (db: ReturnType<typeof openDb>, canonical: string) => createQuestion(db, { canonical, kind: "global", isFactual: true });

test("answering a question requeues only jobs with no remaining blockers", () => {
  const db = openDb(":memory:");
  const q1 = q(db, "Need sponsorship?"), q2 = q(db, "Pronouns?");
  const a = mkJob(db, 1), b = mkJob(db, 2);
  addBlocker(db, a.id, q1.id, "missing"); addBlocker(db, b.id, q1.id, "missing"); addBlocker(db, b.id, q2.id, "approval");
  const { requeued } = answerQuestion(db, q1.id, "No");
  expect(requeued).toEqual([a.id]);
  expect(getJob(db, a.id)!.status).toBe("queued");
  expect(getJob(db, b.id)!.status).toBe("needs-you");
  expect(blockersForJob(db, b.id)).toEqual([{ questionId: q2.id, reason: "approval" }]);
  expect(getQuestion(db, q1.id)).toMatchObject({ status: "approved", answer: "No" });
});

test("clearBlockersForJob removes only that job's blockers", () => {
  const db = openDb(":memory:");
  const q1 = q(db, "Need sponsorship?");
  const a = mkJob(db, 1), b = mkJob(db, 2);
  addBlocker(db, a.id, q1.id, "missing"); addBlocker(db, b.id, q1.id, "missing");
  clearBlockersForJob(db, a.id);
  expect(blockersForJob(db, a.id)).toEqual([]);
  expect(blockersForJob(db, b.id)).toEqual([{ questionId: q1.id, reason: "missing" }]);
});

test("inboxItems groups jobs per question, most-blocking first", () => {
  const db = openDb(":memory:");
  const q1 = q(db, "One"), q2 = q(db, "Two"), q3 = createQuestion(db, { canonical: "Done", kind: "global", isFactual: false });
  const a = mkJob(db, 1), b = mkJob(db, 2);
  addBlocker(db, a.id, q1.id, "missing");
  addBlocker(db, a.id, q2.id, "missing"); addBlocker(db, b.id, q2.id, "missing");
  approveAnswer(db, q3.id, "x"); addBlocker(db, a.id, q3.id, "approval");
  const items = inboxItems(db);
  expect(items.map(i => i.question.id)).toEqual([q2.id, q1.id, q3.id]);
  expect(items[0]!.jobs.map(j => j.id).sort()).toEqual([a.id, b.id].sort());
  expect(items[0]!.jobs[0]).toMatchObject({ company: expect.any(String), title: "Intern" });
});

test("inboxItems includes an approved question that still blocks a job, with its saved answer", () => {
  const db = openDb(":memory:");
  const q3 = createQuestion(db, { canonical: "Done", kind: "global", isFactual: false });
  approveAnswer(db, q3.id, "saved");
  const a = mkJob(db, 1);
  addBlocker(db, a.id, q3.id, "approval");
  const items = inboxItems(db);
  expect(items).toHaveLength(1);
  expect(items[0]!.question).toMatchObject({ id: q3.id, status: "approved", answer: "saved" });
  answerQuestion(db, q3.id, "saved2");
  expect(inboxItems(db)).toEqual([]);
});

test("addVariant dedupes labels", () => {
  const db = openDb(":memory:");
  const x = q(db, "Q");
  addVariant(db, x.id, "Label A"); addVariant(db, x.id, "Label A"); addVariant(db, x.id, "Label B");
  expect(getQuestion(db, x.id)!.variants).toEqual(["Label A", "Label B"]);
});

test("create/draft/approve/list/search/use/delete", () => {
  const db = openDb(":memory:");
  const a = createQuestion(db, { canonical: "Why us?", kind: "template", isFactual: false, draft: "Because", options: ["x", "y"] });
  expect(a).toMatchObject({ status: "draft", draft: "Because", options: ["x", "y"], useCount: 0, answer: null });
  const b = q(db, "Visa?");
  expect(b.status).toBe("none");
  setDraft(db, b.id, "No visa"); expect(getQuestion(db, b.id)).toMatchObject({ status: "draft", draft: "No visa" });
  approveAnswer(db, b.id, "None", "template"); incrementUse(db, b.id);
  expect(getQuestion(db, b.id)).toMatchObject({ status: "approved", answer: "None", kind: "template", useCount: 1 });
  addVariant(db, a.id, "Motivation");
  expect(listQuestions(db, { status: "approved" }).map(x => x.id)).toEqual([b.id]);
  expect(listQuestions(db, { search: "motiv" }).map(x => x.id)).toEqual([a.id]);
  expect(listQuestions(db)).toHaveLength(2);
  const j = mkJob(db, 1); addBlocker(db, j.id, a.id, "missing");
  deleteQuestion(db, a.id);
  expect(getQuestion(db, a.id)).toBeNull();
  expect(blockersForJob(db, j.id)).toEqual([]);
});

test("needs-you items and per-job overrides", () => {
  const db = openDb(":memory:");
  const j = mkJob(db, 1), k = mkJob(db, 2);
  const id = addNeedsYou(db, { jobId: j.id, kind: "captcha", message: "solve" });
  addNeedsYou(db, { jobId: k.id, kind: "login", message: "log in" });
  expect(listOpenNeedsYou(db)).toHaveLength(2);
  expect(listOpenNeedsYou(db)[0]).toMatchObject({ id, jobId: j.id, kind: "captcha", message: "solve" });
  resolveNeedsYouForJob(db, j.id);
  expect(listOpenNeedsYou(db).map(n => n.jobId)).toEqual([k.id]);
  setOverride(db, j.id, "Phone", { type: "text", text: "1" });
  setOverride(db, j.id, "Phone", { type: "text", text: "2" });
  setOverride(db, j.id, "Agree", { type: "check", checked: true });
  expect(getOverrides(db, j.id)).toEqual({ Phone: { type: "text", text: "2" }, Agree: { type: "check", checked: true } });
});
