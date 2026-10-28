import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { addVariant, createQuestion, getOverrides, getQuestion } from "../../src/answers/bank.js";
import { openDb } from "../../src/db/db.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import { paths } from "../../src/paths.js";
import type { Resolution } from "../../src/answers/resolve.js";
import { saveSnapshot } from "../../src/runner/records.js";
import type { Posting } from "../../src/sources/types.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const p = (n: number): Posting => ({ sourceId: "s", listingId: String(n), company: `Co${n}`, title: "Intern", locations: ["NYC"],
  category: null, terms: [], degrees: [], sponsorship: null, url: `https://x.test/${n}`, datePosted: new Date("2026-10-20"), active: true });

function setup() {
  const db = openDb(":memory:");
  const runReviewed = vi.fn();
  const app = createApp({ db, llm: new FakeLlm(), runInteractive: vi.fn(), runReviewed, pollNow: vi.fn() });
  const mk = (n: number, status: Parameters<typeof setStatus>[2], reason: string | null = null) => {
    const j = upsertPosting(db, p(n)).job;
    setStatus(db, j.id, status, reason);
    return j;
  };
  return { db, app, runReviewed, mk };
}
const form = (o: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(o), headers: { "content-type": "application/x-www-form-urlencoded" } });

const FIELDS: FieldSpec[] = [
  { id: "f1", label: "Full name", kind: "text", required: true },
  { id: "f2", label: "Why us?", kind: "textarea", required: true },
];
const RES: Resolution[] = [
  { fieldId: "f1", status: "filled", answer: { type: "text", text: "Ada <i>Lovelace</i>" }, source: "profile" },
  { fieldId: "f2", status: "filled", answer: { type: "text", text: "Great mission" }, source: "bank" },
];

test("list filtering by status shows the right rows and chip counts", async () => {
  const { app, mk } = setup();
  mk(1, "failed", "Boom"); mk(2, "failed"); mk(3, "queued");
  const html = await (await app.request("/applications?status=failed")).text();
  expect(html).toContain("Co1"); expect(html).toContain("Co2"); expect(html).not.toContain("Co3");
  expect(html).toMatch(/failed[^<]*<span[^>]*>2</);
  expect(html).toMatch(/queued[^<]*<span[^>]*>1</);
  expect(html).toContain("Boom");
  const all = await (await app.request("/applications")).text();
  expect(all).toContain("Co3");
});

test("the list shows 50 per page", async () => {
  const { app, mk } = setup();
  for (let i = 1; i <= 52; i++) mk(i, "queued");
  const one = await (await app.request("/applications?status=queued")).text();
  expect(one.match(/<tr>/g)!.length - 1).toBe(50);
  const two = await (await app.request("/applications?status=queued&page=2")).text();
  expect(two.match(/<tr>/g)!.length - 1).toBe(2);
});

test("inbox badge count is passed to the layout", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "needs-you");
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  const { addBlocker } = await import("../../src/answers/bank.js");
  addBlocker(db, j.id, q.id, "missing");
  expect(await (await app.request("/applications")).text()).toContain('class="badge"');
});

test("detail of a ready-to-review job renders an editable input per snapshot field, escaped", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "ready-to-review", "Waiting for your review");
  saveSnapshot(db, j.id, { fields: FIELDS, resolutions: RES, screenshot: Buffer.from("png") });
  const html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).toContain('action="/applications/' + j.id + '/field"');
  expect(html.match(/name="value"/g)).toHaveLength(2);
  expect(html).toContain("Ada &lt;i&gt;Lovelace&lt;/i&gt;");
  expect(html).not.toContain("<i>Lovelace");
  expect(html).toContain("bank");
  expect(html).toContain('href="https://x.test/1"');
  expect(html).toMatch(/src="\/records\/[^"]+snapshot-/);
  expect(html).toContain("Submit"); expect(html).toContain("Skip"); expect(html).toContain("Mark applied manually");
  expect(html).not.toContain("Retry");
});

test("detail of a non-review job shows fields read-only", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "failed", "Nope");
  saveSnapshot(db, j.id, { fields: FIELDS, resolutions: RES, screenshot: null });
  const html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).not.toContain('name="value"');
  expect(html).toContain("Great mission");
  expect(html).toContain("Retry");
  expect((await app.request("/applications/nope")).status).toBe(404);
});

test("an override POST persists and a saveToBank POST also approves the bank question", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "ready-to-review");
  const q = createQuestion(db, { canonical: "Why us?", kind: "global", isFactual: false });
  saveSnapshot(db, j.id, { fields: FIELDS, resolutions: RES, screenshot: null });
  let res = await app.request(`/applications/${j.id}/field`, form({ label: "Full name", value: "Ada L" }));
  expect(res.status).toBe(303);
  expect(getOverrides(db, j.id)["Full name"]).toEqual({ type: "text", text: "Ada L" });
  expect(getQuestion(db, q.id)!.status).toBe("none");
  res = await app.request(`/applications/${j.id}/field`, form({ label: "Why us?", value: "Better answer", saveToBank: "1" }));
  expect(res.status).toBe(303);
  expect(getOverrides(db, j.id)["Why us?"]).toEqual({ type: "text", text: "Better answer" });
  expect(getQuestion(db, q.id)).toMatchObject({ status: "approved", answer: "Better answer" });
  // an unknown label or a job not in review is refused
  expect((await app.request(`/applications/${j.id}/field`, form({ label: "Nope", value: "x" }))).status).toBe(400);
  const other = mk(2, "failed");
  expect((await app.request(`/applications/${other.id}/field`, form({ label: "Full name", value: "x" }))).status).toBe(409);
});

test("submit calls runReviewed only for ready-to-review jobs", async () => {
  const { app, runReviewed, mk } = setup();
  const j = mk(1, "ready-to-review"), f = mk(2, "failed");
  expect((await app.request(`/applications/${j.id}/submit`, form({}))).status).toBe(303);
  expect(runReviewed).toHaveBeenCalledWith(j.id);
  expect((await app.request(`/applications/${f.id}/submit`, form({}))).status).toBe(409);
  expect(runReviewed).toHaveBeenCalledTimes(1);
});

test("skip, mark-applied and retry move the status", async () => {
  const { db, app, mk } = setup();
  const a = mk(1, "ready-to-review"), b = mk(2, "queued"), c = mk(3, "failed", "Boom"), d = mk(4, "unsupported", "foo");
  await app.request(`/applications/${a.id}/skip`, form({}));
  expect(getJob(db, a.id)).toMatchObject({ status: "skipped", statusReason: "Skipped by you" });
  await app.request(`/applications/${b.id}/mark-applied`, form({}));
  expect(getJob(db, b.id)!.status).toBe("applied-manually");
  await app.request(`/applications/${c.id}/retry`, form({}));
  expect(getJob(db, c.id)!.status).toBe("queued");
  await app.request(`/applications/${d.id}/retry`, form({}));
  expect(getJob(db, d.id)!.status).toBe("queued");
  expect((await app.request(`/applications/${a.id}/retry`, form({}))).status).toBe(409);
});

test("retry of a state-unknown needs-you job warns and requires confirmation", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "needs-you", "Submission state unknown — check before retrying");
  const html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).toContain("This application may already have been sent — check your email or the company&#39;s site first.");
  expect(html).toContain('name="confirm"');
  expect((await app.request(`/applications/${j.id}/retry`, form({}))).status).toBe(400);
  expect(getJob(db, j.id)!.status).toBe("needs-you");
  expect((await app.request(`/applications/${j.id}/retry`, form({ confirm: "1" }))).status).toBe(303);
  expect(getJob(db, j.id)!.status).toBe("queued");
  const plain = mk(2, "needs-you", "CAPTCHA");
  expect(await (await app.request(`/applications/${plain.id}`)).text()).not.toContain("Retry");
  expect((await app.request(`/applications/${plain.id}/retry`, form({ confirm: "1" }))).status).toBe(409);
});

test("/records serves files inside the records dir only", async () => {
  const { app } = setup();
  mkdirSync(path.join(paths.records, "job"), { recursive: true });
  writeFileSync(path.join(paths.records, "job", "a.png"), "PNG");
  writeFileSync(paths.db, "secret");
  const ok = await app.request("/records/job/a.png");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/png");
  expect(await ok.text()).toBe("PNG");
  for (const bad of ["/records/../app.db", "/records/%2e%2e/app.db", "/records/..%2fapp.db", "/records/job/%2e%2e%2f%2e%2e%2fapp.db", "/records/job", "/records/missing.png", "/records/%zz"])
    expect((await app.request(bad)).status, bad).toBe(404);
});

test("file fields are read-only and refuse overrides, even when blank", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "ready-to-review");
  const fields: FieldSpec[] = [{ id: "r", label: "Resume", kind: "file", required: false }];
  saveSnapshot(db, j.id, { fields, resolutions: [{ fieldId: "r", status: "skip" }], screenshot: null });
  const html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).not.toContain('name="value"');
  expect((await app.request(`/applications/${j.id}/field`, form({ label: "Resume", value: "x.pdf" }))).status).toBe(400);
  expect(getOverrides(db, j.id)).toEqual({});
});

test("option fields render their options and validate edits against them", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "ready-to-review");
  const fields: FieldSpec[] = [
    { id: "s", label: "Sponsor?", kind: "select", required: true, options: ["Yes", "No"] },
    { id: "g", label: "Langs", kind: "checkbox-group", required: false, options: ["Go", "Rust", "C"] },
  ];
  saveSnapshot(db, j.id, { fields, resolutions: [
    { fieldId: "s", status: "filled", answer: { type: "option", option: "No" }, source: "profile" },
    { fieldId: "g", status: "filled", answer: { type: "options", options: ["Go"] }, source: "profile" }], screenshot: null });
  const html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).toContain("<select name=\"value\">");
  expect(html.match(/type="checkbox" name="value"/g)).toHaveLength(3);
  const post = (label: string, body: URLSearchParams) => { body.set("label", label); return app.request(`/applications/${j.id}/field`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }); };
  expect((await post("Sponsor?", new URLSearchParams({ value: "yes" }))).status).toBe(303);
  expect(getOverrides(db, j.id)["Sponsor?"]).toEqual({ type: "option", option: "Yes" });
  expect((await post("Sponsor?", new URLSearchParams({ value: "Maybe" }))).status).toBe(400);
  const multi = new URLSearchParams(); multi.append("value", "Go"); multi.append("value", "rust");
  expect((await post("Langs", multi)).status).toBe(303);
  expect(getOverrides(db, j.id)["Langs"]).toEqual({ type: "options", options: ["Go", "Rust"] });
  const bad = new URLSearchParams(); bad.append("value", "Cobol");
  expect((await post("Langs", bad)).status).toBe(400);
});

test("save-to-bank is offered and applied only for bank-sourced fields", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "ready-to-review");
  const q = createQuestion(db, { canonical: "About you", kind: "template", isFactual: false });
  const fields: FieldSpec[] = [{ id: "t", label: "About you", kind: "textarea", required: false }];
  saveSnapshot(db, j.id, { fields, resolutions: [{ fieldId: "t", status: "filled", answer: { type: "text", text: "x" }, source: "template" }], screenshot: null });
  expect(await (await app.request(`/applications/${j.id}`)).text()).not.toContain("saveToBank");
  const res = await app.request(`/applications/${j.id}/field`, form({ label: "About you", value: "Co1 specific", saveToBank: "1" }));
  expect(res.headers.get("location")).toBe(`/applications/${j.id}`);
  expect(getQuestion(db, q.id)!.status).toBe("none");
});

test("save-to-bank with no or several matching questions says so and approves nothing", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "ready-to-review");
  saveSnapshot(db, j.id, { fields: FIELDS, resolutions: RES, screenshot: null });
  let res = await app.request(`/applications/${j.id}/field`, form({ label: "Why us?", value: "A", saveToBank: "1" }));
  expect(res.headers.get("location")).toBe(`/applications/${j.id}?notice=bank-miss`);
  const html = await (await app.request(res.headers.get("location")!)).text();
  expect(html).toContain("Saved for this job only — no matching answer-bank question");
  const q1 = createQuestion(db, { canonical: "Why us?", kind: "global", isFactual: false });
  const q2 = createQuestion(db, { canonical: "Another wording", kind: "global", isFactual: false });
  addVariant(db, q2.id, "Why us?");
  res = await app.request(`/applications/${j.id}/field`, form({ label: "Why us?", value: "B", saveToBank: "1" }));
  expect(res.headers.get("location")).toContain("notice=bank-miss");
  expect(getQuestion(db, q1.id)!.status).toBe("none"); expect(getQuestion(db, q2.id)!.status).toBe("none");
  expect(getOverrides(db, j.id)["Why us?"]).toEqual({ type: "text", text: "B" });
});
