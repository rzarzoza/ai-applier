import { expect, test } from "vitest";
import { addVariant, createQuestion, getQuestion, listQuestions } from "../../src/answers/bank.js";
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
