import { expect, test, vi } from "vitest";
import { openDb } from "../../src/db/db.js";
import { addBlocker, addNeedsYou, addVariant, approveAnswer, blockersForJob, createQuestion, getOverrides, getQuestion, openNeedsYouForJob } from "../../src/answers/bank.js";
import { getJob, RESUME_NEEDED, setStatus, upsertPosting } from "../../src/jobs/repo.js";
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
  const app = createApp({ db, llm, runInteractive, runReviewed: vi.fn(), runHandFinish: vi.fn(), pollNow });
  const mk = (n: number) => { const j = upsertPosting(db, p(n)).job; setStatus(db, j.id, "needs-you"); return j; };
  return { db, llm, app, runInteractive, mk };
}
const form = (o: Record<string, string>) => ({ method: "POST", body: new URLSearchParams(o), headers: { "content-type": "application/x-www-form-urlencoded" } });


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
  for (const tab of ["Home", "Inbox", "Applications", "Answer bank", "Profile", "Sources &amp; filters", "Settings"])
    expect(html).toContain(`<span class="tab-label">${tab}</span>`);
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

test("each blocked job shows the form's exact wording with Copy, its section, field type, choices and a link to the posting", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Education start year", kind: "global", isFactual: true });
  const label = 'Start date month/year <script>alert("x")</script>';
  const a = mk(1), b = mk(2);
  addBlocker(db, a.id, q.id, "missing", { label, kind: "select", options: ["2024", "2025 & later"], description: "Employment — most recent role" });
  addBlocker(db, b.id, q.id, "missing"); // stored before the form's field was recorded
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("<h3>Education start year</h3>");
  expect(html).toContain('<blockquote class="field-label">Start date month/year &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</blockquote>');
  expect(html).not.toContain('<script>alert("x")</script>');
  expect(html).toContain('<button type="button" class="copy" data-copy="true">Copy</button>');
  expect(html).toContain("navigator.clipboard.writeText(t.textContent)");
  expect(html).toContain("Section / help text: Employment — most recent role");
  expect(html).toContain("Field type: Dropdown (pick one)");
  expect(html).toContain("Choices: 2024 · 2025 &amp; later");
  expect(html).toContain('<a href="https://x.test/1" target="_blank" rel="noopener">Open posting</a>');
  expect(html).toContain("<strong>Co1</strong> · Intern");
  expect(html).toContain('<a href="https://x.test/2" target="_blank" rel="noopener">Open posting</a>');
  expect(html).toContain("exact wording wasn&#39;t recorded");
  expect(html).toContain("Re-check with my profile");
});

test("a posting link that isn't http(s) is not rendered as a link", async () => {
  const { db, app } = setup();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  const j = upsertPosting(db, { ...p(1), url: "javascript:alert(1)" }).job; setStatus(db, j.id, "needs-you");
  addBlocker(db, j.id, q.id, "missing", { label: "Q?", kind: "text" });
  const html = await (await app.request("/inbox")).text();
  expect(html).not.toContain("javascript:alert");
  expect(html).not.toContain("Open posting");
});

test("a suggested answer shows where it came from", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Export control status", kind: "global", isFactual: true, options: ["Yes", "No"], draft: "Yes", draftBasis: "profile.usCitizen = true" });
  addBlocker(db, mk(1).id, q.id, "approval", { label: "Are you a U.S. citizen…?", kind: "radio", options: ["Yes", "No"] });
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("Suggested from your profile/resume:");
  expect(html).toContain('<div class="draft">Yes</div>');
  expect(html).toContain("Based on: profile.usCitizen = true");
  expect(html).toContain("Use draft");
});

test("revising a suggestion drops its profile basis", async () => {
  const { db, llm, app, mk } = setup();
  llm.on("revise", () => ({ draft: "Rice" }));
  const q = createQuestion(db, { canonical: "School", kind: "global", isFactual: true, draft: "Rice University", draftBasis: "profile.school" });
  addBlocker(db, mk(1).id, q.id, "approval");
  await app.request(`/inbox/${q.id}/revise`, form({ instruction: "shorter" }));
  expect(getQuestion(db, q.id)).toMatchObject({ draft: "Rice", draftBasis: null });
});

test("POST /inbox/recheck requeues blocked jobs only, clearing their blockers", async () => {
  const { db, app, mk } = setup();
  const q = createQuestion(db, { canonical: "Q?", kind: "global", isFactual: true });
  const blocked = mk(1), other = mk(2);
  addBlocker(db, blocked.id, q.id, "missing"); addBlocker(db, other.id, q.id, "approval");
  const captcha = mk(3); addBlocker(db, captcha.id, q.id, "missing"); addNeedsYou(db, { jobId: captcha.id, kind: "captcha", message: "solve" });
  const unknown = mk(4); setStatus(db, unknown.id, "needs-you", "Submission state unknown — check before retrying");
  addBlocker(db, unknown.id, q.id, "missing");
  const resume = mk(5); setStatus(db, resume.id, "needs-you", RESUME_NEEDED);
  const done = upsertPosting(db, p(6)).job; setStatus(db, done.id, "submitted"); addBlocker(db, done.id, q.id, "missing");

  const res = await app.request("/inbox/recheck", { method: "POST" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/inbox?rechecked=2");
  for (const j of [blocked, other]) {
    expect(getJob(db, j.id)!.status).toBe("queued");
    expect(blockersForJob(db, j.id)).toEqual([]);
  }
  for (const j of [captcha, unknown, resume]) expect(getJob(db, j.id)!.status).toBe("needs-you");
  expect(blockersForJob(db, captcha.id)).toHaveLength(1);
  expect(blockersForJob(db, unknown.id)).toHaveLength(1);
  expect(openNeedsYouForJob(db, captcha.id)).toHaveLength(1);
  expect(getJob(db, done.id)!.status).toBe("submitted");
  expect(await (await app.request("/inbox?rechecked=2")).text()).toContain("Re-checking 2 jobs");
});

test("the dashboard's own Re-check form passes the host and origin guard", async () => {
  const db = openDb(":memory:");
  const app = createApp({ db, llm: new FakeLlm(), runInteractive: vi.fn(), runReviewed: vi.fn(), runHandFinish: vi.fn(), pollNow: vi.fn(), localPort: () => 4310 });
  const j = upsertPosting(db, p(1)).job; setStatus(db, j.id, "needs-you");
  const req = (origin: string) => new Request("http://127.0.0.1:4310/inbox/recheck", { method: "POST", headers: { host: "127.0.0.1:4310", origin } });
  expect((await app.request(req("http://evil.test"))).status).toBe(403);
  expect(getJob(db, j.id)!.status).toBe("needs-you");
  expect((await app.request(req("http://127.0.0.1:4310"))).status).toBe(303);
  expect(getJob(db, j.id)!.status).toBe("queued");
});

/** Two fact drafts from the profile/resume and one open-ended LLM draft, each blocking needs-you jobs with their form wording. */
function suggestions() {
  const s = setup();
  const { db, mk } = s;
  const citizen = createQuestion(db, { canonical: "Are you a U.S. citizen?", kind: "global", isFactual: true, draft: "Yes", draftBasis: "profile.usCitizen = true" });
  const school = createQuestion(db, { canonical: "School enrolled in", kind: "global", isFactual: true, draft: "Rice University", draftBasis: "resume: Rice University, B.S. Computer Science" });
  const why = createQuestion(db, { canonical: "Why {company}?", kind: "template", isFactual: false, draft: "Because I love it" });
  const a = mk(1), b = mk(2), c = mk(3);
  addBlocker(db, a.id, citizen.id, "approval", { label: "Are you a citizen of the United States?", kind: "radio", options: ["Yes", "No"] });
  addBlocker(db, b.id, citizen.id, "approval", { label: "U.S. citizenship status", kind: "select", options: ["Yes", "No"] });
  addBlocker(db, b.id, school.id, "approval", { label: "Which institution do you attend?", kind: "text" });
  addBlocker(db, c.id, why.id, "approval", { label: "Why do you want to work at Co3?", kind: "textarea" });
  // A fact draft blocking no needs-you job is not counted.
  const idle = createQuestion(db, { canonical: "Graduation year", kind: "global", isFactual: true, draft: "2027", draftBasis: "profile.graduationYear = 2027" });
  const done = upsertPosting(db, p(4)).job;
  setStatus(db, done.id, "submitted");
  addBlocker(db, done.id, idle.id, "approval");
  return { ...s, citizen, school, why, idle, a, b, c };
}

test("the Inbox and Home offer to approve only the profile-based suggestions blocking jobs", async () => {
  const { app } = suggestions();
  const inbox = await (await app.request("/inbox")).text();
  expect(inbox).toContain("Approve all 2 profile-based suggestions");
  expect(inbox).toContain('href="/inbox/approve-suggestions"');
  const home = await (await app.request("/")).text();
  expect(home).toContain("Approve all 2 profile-based suggestions");
});

test("no button without profile-based suggestions", async () => {
  const { db, app, mk } = setup();
  const why = createQuestion(db, { canonical: "Why us?", kind: "template", isFactual: false, draft: "Because" });
  addBlocker(db, mk(1).id, why.id, "approval");
  expect(await (await app.request("/inbox")).text()).not.toContain("profile-based suggestion");
  expect(await (await app.request("/")).text()).not.toContain("profile-based suggestion");
});

test("the confirmation list shows each fact draft with the forms' exact wording, answer and basis — never an LLM-written draft", async () => {
  const { app, citizen, school, why, idle } = suggestions();
  const html = await (await app.request("/inbox/approve-suggestions")).text();
  expect(html).toContain("Are you a U.S. citizen?");
  expect(html).toContain("Are you a citizen of the United States?");
  expect(html).toContain("U.S. citizenship status");
  expect(html).toContain("profile.usCitizen = true");
  expect(html).toContain("Which institution do you attend?");
  expect(html).toContain("Rice University");
  expect(html).toContain("resume: Rice University, B.S. Computer Science");
  expect(html).toContain(`name="q" value="${citizen.id}" checked`);
  expect(html).toContain(`name="q" value="${school.id}" checked`);
  expect(html).not.toContain(`value="${why.id}"`);
  expect(html).not.toContain("Because I love it");
  expect(html).not.toContain(`value="${idle.id}"`);
  expect(html).toContain("Approve all");
});

test("approving all checked suggestions approves only those, requeues their jobs and leaves unchecked rows untouched", async () => {
  const { db, app, citizen, school, why, a, b, c } = suggestions();
  const body = new URLSearchParams([["q", String(citizen.id)], [`d:${citizen.id}`, "Yes"]]);
  const res = await app.request("/inbox/approve-suggestions", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/inbox?approved=1&requeued=1");
  expect(getQuestion(db, citizen.id)).toMatchObject({ status: "approved", answer: "Yes" });
  // Unchecked: still a draft, still blocking its job.
  expect(getQuestion(db, school.id)).toMatchObject({ status: "draft", answer: null, draft: "Rice University" });
  expect(blockersForJob(db, b.id)).toEqual([{ questionId: school.id, reason: "approval" }]);
  expect(getJob(db, a.id)!.status).toBe("queued");
  expect(getJob(db, b.id)!.status).toBe("needs-you");
  // The LLM-written draft is never approved, even when posted.
  await app.request("/inbox/approve-suggestions", form({ q: String(why.id) }));
  expect(getQuestion(db, why.id)).toMatchObject({ status: "draft", answer: null });
  expect(getJob(db, c.id)!.status).toBe("needs-you");
  expect(await (await app.request("/inbox?approved=1&requeued=1")).text()).toContain("Approved 1 suggestion · 1 job re-queued");
});

test("approving both suggestions requeues every job they blocked; a draft changed since the list was shown is left alone", async () => {
  const { db, app, citizen, school, a, b } = suggestions();
  const body = new URLSearchParams([["q", String(citizen.id)], ["q", String(school.id)], [`d:${citizen.id}`, "Yes"], [`d:${school.id}`, "Rice University"]]);
  const res = await app.request("/inbox/approve-suggestions", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(res.headers.get("location")).toBe("/inbox?approved=2&requeued=2");
  expect(getJob(db, a.id)!.status).toBe("queued");
  expect(getJob(db, b.id)!.status).toBe("queued");

  const s = suggestions();
  const stale = new URLSearchParams([["q", String(s.school.id)], [`d:${s.school.id}`, "Old text"]]);
  await s.app.request("/inbox/approve-suggestions", { method: "POST", body: stale, headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(getQuestion(s.db, s.school.id)!.status).toBe("draft");
});

test("posting with nothing ticked approves nothing", async () => {
  const { db, app, citizen } = suggestions();
  const res = await app.request("/inbox/approve-suggestions", form({}));
  expect(await res.text()).toContain("Nothing was ticked");
  expect(getQuestion(db, citizen.id)!.status).toBe("draft");
});
