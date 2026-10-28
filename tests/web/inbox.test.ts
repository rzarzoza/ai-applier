import { expect, test, vi } from "vitest";
import { openDb } from "../../src/db/db.js";
import { addBlocker, addNeedsYou, addVariant, approveAnswer, createQuestion, getOverrides, getQuestion } from "../../src/answers/bank.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { Posting } from "../../src/sources/types.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const p = (n: number): Posting => ({ sourceId: "s", listingId: String(n), company: `Co${n}`, title: "Intern", locations: ["NYC"],
  category: null, terms: [], degrees: [], sponsorship: null, url: `https://x.test/${n}`, datePosted: new Date("2026-10-20"), active: true });

function setup() {
  const db = openDb(":memory:");
  const llm = new FakeLlm();
  const runInteractive = vi.fn();
  const pollNow = vi.fn();
  const app = createApp({ db, llm, runInteractive, runReviewed: vi.fn(), pollNow });
  const mk = (n: number) => { const j = upsertPosting(db, p(n)).job; setStatus(db, j.id, "needs-you"); return j; };
  return { db, llm, app, runInteractive, mk };
}
const form = (o: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(o), headers: { "content-type": "application/x-www-form-urlencoded" } });

test("GET / redirects to /inbox", async () => {
  const { app } = setup();
  const res = await app.request("/");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/inbox");
});

test("GET /inbox lists a blocked question with its blocked-job count, variants and needs-you items", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Do you need <b>sponsorship</b>?", kind: "global", isFactual: true });
  addVariant(db, q.id, "Visa status");
  const a = mk(1), b = mk(2);
  addBlocker(db, a.id, q.id, "missing"); addBlocker(db, b.id, q.id, "missing");
  addNeedsYou(db, { jobId: a.id, kind: "captcha", message: "Solve the captcha" });
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("Blocking 2 jobs");
  expect(html).toContain("Co1, Co2");
  expect(html).toContain("Visa status");
  expect(html).toContain("Do you need &lt;b&gt;sponsorship&lt;/b&gt;?");
  expect(html).not.toContain("<b>sponsorship</b>");
  expect(html).toContain("<textarea");
  expect(html).toContain("Needs you");
  expect(html).toContain("Solve the captcha");
  expect(html).toContain("Do it now");
  expect(html).toContain("https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js");
  for (const tab of ["Inbox", "Applications", "Answer bank", "Profile &amp; resume", "Sources &amp; filters", "Settings"]) expect(html).toContain(tab);
});

test("a draft shows Use draft / Edit / Tell AI; options render a select; template shows the checkbox", async () => {
  const { db, app, mk } = setup();
  const d = createQuestion(db, { canonical: "Why us?", kind: "template", isFactual: false, draft: "Because of X" });
  const o = createQuestion(db, { canonical: "Pick one", kind: "global", isFactual: true, options: ["Yes", "No"] });
  addBlocker(db, mk(1).id, d.id, "approval"); addBlocker(db, mk(2).id, o.id, "missing");
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("Use draft"); expect(html).toContain("Edit"); expect(html).toContain("Tell AI what to change");
  expect(html).toContain("Because of X");
  expect(html).toContain("Save as template");
  expect(html).toContain("<select"); expect(html).toContain("<option");
});

test("an approved question that still blocks says the saved answer didn't fit and prefills it", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  await app.request(`/inbox/${q.id}/answer`, form({ text: "old answer" }));
  addBlocker(db, mk(1).id, q.id, "approval");
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("Your saved answer didn&#39;t fit this form");
  expect(html).toContain("old answer");
});

test("POST /inbox/:id/answer approves and requeues both jobs", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  const a = mk(1), b = mk(2);
  addBlocker(db, a.id, q.id, "missing"); addBlocker(db, b.id, q.id, "missing");
  const res = await app.request(`/inbox/${q.id}/answer`, form({ text: "No" }));
  expect(await res.text()).toContain("2 jobs re-queued");
  expect(getQuestion(db, q.id)).toMatchObject({ status: "approved", answer: "No" });
  expect(getJob(db, a.id)!.status).toBe("queued"); expect(getJob(db, b.id)!.status).toBe("queued");
});

test("answer with the template checkbox saves kind=template; unchecked on a template makes it global", async () => {
  const { db, app } = setup();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: false });
  await app.request(`/inbox/${q.id}/answer`, form({ text: "A", kind: "template" }));
  expect(getQuestion(db, q.id)!.kind).toBe("template");
  await app.request(`/inbox/${q.id}/answer`, form({ text: "A", kindChoice: "1" }));
  expect(getQuestion(db, q.id)!.kind).toBe("global");
});

test("POST /inbox/:id/use-draft approves the draft and requeues jobs", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: false, draft: "Draft text" });
  const a = mk(1); addBlocker(db, a.id, q.id, "approval");
  const res = await app.request(`/inbox/${q.id}/use-draft`, { method: "POST" });
  expect(await res.text()).toContain("1 job re-queued");
  expect(getQuestion(db, q.id)).toMatchObject({ status: "approved", answer: "Draft text" });
  expect(getJob(db, a.id)!.status).toBe("queued");
});

test("POST /inbox/:id/revise calls the LLM and re-renders the card with the new draft", async () => {
  const { db, llm, app, mk } = setup();
  llm.on("revise", () => ({ draft: "Shorter draft" }));
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: false, draft: "Long draft" });
  addBlocker(db, mk(1).id, q.id, "approval");
  const res = await app.request(`/inbox/${q.id}/revise`, form({ instruction: "make it shorter" }));
  const html = await res.text();
  expect(llm.calls.map(c => c.name)).toEqual(["revise"]);
  expect(html).toContain("Shorter draft");
  expect(getQuestion(db, q.id)!.draft).toBe("Shorter draft");
});

test("POST /needs-you/:jobId/do-it-now starts the interactive run for a CAPTCHA, code or login", async () => {
  const { db, app, runInteractive, mk } = setup();
  for (const [n, kind] of [[1, "captcha"], [2, "code"], [3, "login"]] as const) {
    const j = mk(n);
    addNeedsYou(db, { jobId: j.id, kind, message: kind });
    const res = await app.request(`/needs-you/${j.id}/do-it-now`, { method: "POST" });
    expect(await res.text()).toContain("Opening browser");
    expect(runInteractive).toHaveBeenLastCalledWith(j.id);
  }
});

test("do-it-now refuses unknown jobs, jobs not in needs-you, and possibly sent applications", async () => {
  const { db, app, runInteractive, mk } = setup();
  expect((await app.request("/needs-you/nope/do-it-now", { method: "POST" })).status).toBe(404);
  const noItem = mk(1);
  const moved = mk(2);
  addNeedsYou(db, { jobId: moved.id, kind: "captcha", message: "solve" });
  setStatus(db, moved.id, "queued");
  const unknown = mk(3);
  setStatus(db, unknown.id, "needs-you", "Submission state unknown — check before retrying");
  addNeedsYou(db, { jobId: unknown.id, kind: "other", message: "may have been sent" });
  const unknownCaptcha = mk(4);
  setStatus(db, unknownCaptcha.id, "needs-you", "Submission state unknown — check before retrying");
  addNeedsYou(db, { jobId: unknownCaptcha.id, kind: "captcha", message: "stale captcha" });
  for (const j of [noItem, moved, unknown, unknownCaptcha]) {
    expect((await app.request(`/needs-you/${j.id}/do-it-now`, { method: "POST" })).status).toBe(409);
  }
  expect(runInteractive).not.toHaveBeenCalled();
});

test("a possibly sent application shows an Open job link instead of Do it now", async () => {
  const { db, app, mk } = setup();
  const j = mk(1);
  setStatus(db, j.id, "needs-you", "Submission state unknown — check before retrying");
  addNeedsYou(db, { jobId: j.id, kind: "other", message: "Co1 · Intern: may have been sent" });
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("may have been sent");
  expect(html).not.toContain("Do it now");
  expect(html).toContain(`href="/applications/${j.id}"`);
  expect(html).toContain("Open job");
});

const blockWith = (db: ReturnType<typeof openDb>, jobId: string, qId: number, options: string[] | null, label = "Authorized to work?") =>
  addBlocker(db, jobId, qId, "missing", { label, kind: options ? "select" : "text", options: options ?? undefined });

test("the card offers the blocking forms' own options when they agree", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Authorized?", kind: "global", isFactual: true, options: ["Old A", "Old B"] });
  blockWith(db, mk(1).id, q.id, ["Yes", "No"]); blockWith(db, mk(2).id, q.id, ["Yes", "No"]);
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain('<option value="Yes"');
  expect(html).not.toContain("Old A");
  expect(html).not.toContain("choice:");
});

test("forms with different options get a free-text answer plus a choice per job", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Authorized?", kind: "global", isFactual: true, options: ["Yes", "No"] });
  const a = mk(1), b = mk(2), c = mk(3);
  blockWith(db, a.id, q.id, ["Yes", "No"]);
  blockWith(db, b.id, q.id, ["Y - I am authorized", "N - I am not"], "Work authorization");
  blockWith(db, c.id, q.id, null);
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("<textarea");
  expect(html).toContain(`name="choice:${a.id}"`);
  expect(html).toContain(`name="choice:${b.id}"`);
  expect(html).not.toContain(`name="choice:${c.id}"`);

  const res = await app.request(`/inbox/${q.id}/answer`, form({ text: "Yes", [`choice:${b.id}`]: "y - i am authorized", [`choice:${a.id}`]: "" }));
  expect(await res.text()).toContain("3 jobs re-queued");
  expect(getQuestion(db, q.id)).toMatchObject({ status: "approved", answer: "Yes" });
  expect(getOverrides(db, b.id)).toEqual({ "Work authorization": { type: "option", option: "Y - I am authorized" } });
  expect(getOverrides(db, a.id)).toEqual({});
});

test("a saved answer that isn't one of the form's options is kept; the pick is saved for that job only", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Authorized?", kind: "global", isFactual: true });
  approveAnswer(db, q.id, "Yes");
  const j = mk(1);
  blockWith(db, j.id, q.id, ["Oui", "Non"]);
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("isn&#39;t an option on this form");
  expect(await (await app.request(`/inbox/${q.id}/answer`, form({ text: "Oui" }))).text()).toContain("1 job re-queued");
  expect(getQuestion(db, q.id)).toMatchObject({ status: "approved", answer: "Yes" });
  expect(getOverrides(db, j.id)).toEqual({ "Authorized to work?": { type: "option", option: "Oui" } });
  expect(getJob(db, j.id)!.status).toBe("queued");
});

test("a per-job choice that isn't one of that form's options is refused and changes nothing", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Authorized?", kind: "global", isFactual: true });
  const a = mk(1), b = mk(2);
  blockWith(db, a.id, q.id, ["Yes", "No"]); blockWith(db, b.id, q.id, ["Y", "N"]);
  const html = await (await app.request(`/inbox/${q.id}/answer`, form({ text: "Yes", [`choice:${b.id}`]: "Maybe" }))).text();
  expect(html).toContain("not one of the options");
  expect(getQuestion(db, q.id)!.status).toBe("none");
  expect(getOverrides(db, b.id)).toEqual({});
  expect(getJob(db, a.id)!.status).toBe("needs-you");
});
