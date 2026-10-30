import { expect, test } from "vitest";
import { addBlocker, addNeedsYou, addVariant, blockersForJob, createQuestion, getQuestion, listQuestions } from "../../src/answers/bank.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { Posting } from "../../src/sources/types.js";
import { form, setupApp } from "./helpers.js";

test("GET /bank lists questions, escapes text and filters by search", async () => {
  const { db, app } = setupApp();
  const q = createQuestion(db, { canonical: "Why <b>us</b>?", kind: "template", isFactual: false });
  addVariant(db, q.id, "Motivation");
  createQuestion(db, { canonical: "Pronouns?", kind: "global", isFactual: true });
  const html = await (await app.request("/bank")).text();
  expect(html).toContain("Why &lt;b&gt;us&lt;/b&gt;?");
  expect(html).toContain("Motivation");
  expect(html).toContain('href="/bank"');
  const found = await (await app.request("/bank?search=motiv")).text();
  expect(found).toContain("Why &lt;b&gt;us");
  expect(found).not.toContain("Pronouns?");
});

test("POST /bank/:id edits the answer and kind and approves it", async () => {
  const { db, app } = setupApp();
  const q = createQuestion(db, { canonical: "Why us?", kind: "global", isFactual: false, draft: "draft" });
  const res = await app.request(`/bank/${q.id}`, form({ answer: "Because.", kind: "template" }));
  expect(res.status).toBe(303);
  expect(getQuestion(db, q.id)).toMatchObject({ answer: "Because.", kind: "template", status: "approved" });
});

test("POST /bank/:id rejects an empty answer and unknown ids", async () => {
  const { db, app } = setupApp();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: false });
  expect((await app.request(`/bank/${q.id}`, form({ answer: "  ", kind: "global" }))).status).toBe(400);
  expect((await app.request(`/bank/999`, form({ answer: "x", kind: "global" }))).status).toBe(404);
});

test("POST /bank/:id/delete removes the question", async () => {
  const { db, app } = setupApp();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: false });
  const res = await app.request(`/bank/${q.id}/delete`, { method: "POST" });
  expect(res.status).toBe(303);
  expect(listQuestions(db)).toHaveLength(0);
});

const posting = (n: number): Posting => ({ sourceId: "s", listingId: String(n), company: `Co${n}`, title: "Intern", locations: ["NYC"],
  category: null, terms: [], degrees: [], sponsorship: null, url: `https://x.test/${n}`, datePosted: new Date("2026-10-20"), active: true });

test("deleting a question requeues needs-you jobs it alone was blocking", async () => {
  const { db, app } = setupApp();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  const other = createQuestion(db, { canonical: "Other?", kind: "global", isFactual: true });
  const mk = (n: number) => { const j = upsertPosting(db, posting(n)).job; setStatus(db, j.id, "needs-you", "1 question needs you"); addBlocker(db, j.id, q.id, "missing"); return j; };
  const freed = mk(1), stillBlocked = mk(2), waitingOnCaptcha = mk(3), skipped = mk(4);
  addBlocker(db, stillBlocked.id, other.id, "missing");
  addNeedsYou(db, { jobId: waitingOnCaptcha.id, kind: "captcha", message: "solve" });
  setStatus(db, skipped.id, "skipped", "Skipped by you");
  expect((await app.request(`/bank/${q.id}/delete`, { method: "POST" })).status).toBe(303);
  expect(getJob(db, freed.id)!.status).toBe("queued");
  expect(getJob(db, stillBlocked.id)!.status).toBe("needs-you");
  expect(getJob(db, waitingOnCaptcha.id)!.status).toBe("needs-you");
  expect(getJob(db, skipped.id)!.status).toBe("skipped");
});

test("editing a question in the bank clears its blockers and requeues the jobs", async () => {
  const { db, app } = setupApp();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  const j = upsertPosting(db, posting(1)).job;
  setStatus(db, j.id, "needs-you", "1 question needs you");
  addBlocker(db, j.id, q.id, "missing");
  await app.request(`/bank/${q.id}`, form({ answer: "Yes", kind: "global" }));
  expect(blockersForJob(db, j.id)).toEqual([]);
  expect(getJob(db, j.id)!.status).toBe("queued");
});
