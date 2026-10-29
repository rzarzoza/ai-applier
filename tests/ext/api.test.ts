import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { approveAnswer, createQuestion, getOverrides, getQuestion, listQuestions, setDraft } from "../../src/answers/bank.js";
import { openDb } from "../../src/db/db.js";
import { companyFromUrl, getExtToken } from "../../src/ext/api.js";
import { findJobByUrl, findJobForPage, postingKey } from "../../src/ext/match.js";
import type { ResolveResponse } from "../../src/ext/protocol.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import { saveProfile } from "../../src/profile/profile.js";
import { trackerRows } from "../../src/tracker/rows.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const HOST = "127.0.0.1:4310";

type C = Record<string, unknown>;
const CLASSES: Record<string, C> = {
  "First Name": { category: "profile", profileKey: "firstName", isFactual: true },
  Phone: { category: "profile", profileKey: "phone", isFactual: true },
  "Why do you want to work here?": { category: "question", canonicalQuestion: "Why do you want to work at {company}?", isFactual: false, isCompanySpecific: true },
  "Tell us about a project you are proud of": { category: "question", canonicalQuestion: "Describe a project you are proud of.", isFactual: false },
  "Describe a project you're proud of": { category: "question", canonicalQuestion: "Describe a project you are proud of.", isFactual: false },
  "How did you hear about us?": { category: "question", canonicalQuestion: "How did you hear about this job?", isFactual: true },
  "Text me about new roles": { category: "optin-optional" },
};

function setup(opts: { draft?: boolean } = {}) {
  const db = openDb(":memory:");
  const llm = new FakeLlm()
    .on("classify", (req: { content: unknown }) => ({
      fields: (JSON.parse(String(req.content)) as { fields: { id: string; label: string }[] }).fields.map(f => ({
        id: f.id, profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: true, isCompanySpecific: false, category: "question", ...CLASSES[f.label],
      })),
    }))
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("draft", () => (opts.draft ? { answerable: true, draft: "I built a compiler." } : { answerable: false, draft: null }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
  saveProfile(db, { firstName: "Luis", lastName: "Hernandez", email: "luis@example.com" });
  const syncTracker = vi.fn().mockResolvedValue({ csv: true, sheet: "skipped" });
  const close = vi.fn().mockResolvedValue(undefined);
  const live = { close, parkedIds: () => [], isParked: () => false } as never;
  const app = createApp({ db, llm, runInteractive: vi.fn(), runReviewed: vi.fn(), runHandFinish: vi.fn(), pollNow: vi.fn(), syncTracker, localPort: () => 4310, live });
  const token = getExtToken(db);
  const call = (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(`http://${HOST}${p}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { host: HOST, origin: EXT, "x-ai-applier-token": token, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { db, llm, app, token, call, syncTracker, close };
}

const field = (id: string, label: string, kind: FieldSpec["kind"] = "text", required = true, extra: Partial<FieldSpec> = {}): FieldSpec =>
  ({ id, label, kind, required, ...extra });

const addJob = (db: ReturnType<typeof openDb>, url: string, company = "Acme") => upsertPosting(db, {
  sourceId: "s", listingId: url, company, title: "Software Engineer Intern", locations: ["Austin, TX"], category: null,
  terms: ["Summer 2027"], degrees: [], sponsorship: null, url, datePosted: new Date(), active: true,
}).job;

test("every /ext request needs the pairing token", async () => {
  const { call } = setup();
  expect((await call("/ext/status", { headers: { "x-ai-applier-token": "" } })).status).toBe(401);
  expect((await call("/ext/status", { headers: { "x-ai-applier-token": "wrong" } })).status).toBe(401);
  expect((await call("/ext/submitted", { body: { url: "https://x.test/1", title: "t", company: "c" }, headers: { "x-ai-applier-token": "wrong" } })).status).toBe(401);
  const ok = await call("/ext/status");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true, paused: false, profileComplete: false, hasResume: false });
});

test("only the extension's origin (or none) is let in, and preflights are answered", async () => {
  const { call } = setup();
  for (const origin of ["http://evil.test", "http://127.0.0.1:4310", "chrome-extension://short", "null"]) {
    expect((await call("/ext/status", { headers: { origin } })).status, origin).toBe(403);
  }
  const ok = await call("/ext/status");
  expect(ok.headers.get("access-control-allow-origin")).toBe(EXT);
  const pre = await call("/ext/resolve", { method: "OPTIONS", headers: { "x-ai-applier-token": "", "access-control-request-method": "POST" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe(EXT);
  expect(pre.headers.get("access-control-allow-headers")).toContain("x-ai-applier-token");
  // No Origin (a service worker's GET) still needs the token.
  expect((await call("/ext/status", { headers: { origin: "" } })).status).toBe(200);
});

test("the dashboard's guard still holds: other hosts are refused, and the extension origin can't drive the dashboard", async () => {
  const { call, app } = setup();
  expect((await call("/ext/status", { headers: { host: "evil.test" } })).status).toBe(403);
  const settings = await app.request(`http://${HOST}/settings`, {
    method: "POST", headers: { host: HOST, origin: EXT, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ reviewMode: "all", pollMinutes: "30" }),
  });
  expect(settings.status).toBe(403);
});

test("resolve fills from the profile and the bank, offers drafts as suggestions, and leaves the rest to the user", async () => {
  const { db, call } = setup({ draft: true });
  const hear = createQuestion(db, { canonical: "How did you hear about this job?", kind: "global", isFactual: true });
  approveAnswer(db, hear.id, "LinkedIn");
  const res = await call("/ext/resolve", { body: {
    url: "https://jobs.lever.co/acme/1234-abcd/apply", title: "Software Engineer Intern", company: "Acme",
    fields: [field("f1", "First Name"), field("f2", "Phone"), field("f3", "Tell us about a project you are proud of", "textarea"),
      field("f4", "How did you hear about this job?"), field("f5", "Text me about new roles", "checkbox", false), field("f6", "Resume", "file")],
  } });
  expect(res.status).toBe(200);
  const body = await res.json() as ResolveResponse;
  const by = Object.fromEntries(body.resolutions.map(r => [r.fieldId, r]));
  expect(by.f1).toMatchObject({ status: "filled", answer: { type: "text", text: "Luis" }, source: "profile" });
  expect(by.f2).toMatchObject({ status: "needs-you", reason: "missing" });
  // An unapproved draft is never filled: it comes back as a suggestion.
  expect(by.f3).toMatchObject({ status: "suggestion", suggestion: { type: "text", text: "I built a compiler." }, text: "I built a compiler." });
  expect(by.f4).toMatchObject({ status: "filled", answer: { type: "text", text: "LinkedIn" }, source: "bank" });
  expect(by.f5).toEqual({ fieldId: "f5", status: "skip" });
  expect(by.f6).toEqual({ fieldId: "f6", status: "needs-you", reason: "file" });
  expect(body.job).toEqual({ id: null, company: "Acme", title: "Software Engineer Intern" });
});

test("resolve uses the matching job row (same posting, other URL form) for company and the per-job overrides", async () => {
  const { db, call } = setup();
  const job = addJob(db, "https://job-boards.greenhouse.io/acme/jobs/123?gh_src=simplify");
  const res = await call("/ext/resolve", { body: {
    url: "https://boards.greenhouse.io/acme/jobs/123#app", title: "Page title", fields: [field("f1", "First Name")],
  } });
  const body = await res.json() as ResolveResponse;
  expect(body.job).toEqual({ id: job.id, company: "Acme", title: "Software Engineer Intern" });
});

test("a resume file field is filled with the resume and /ext/resume serves its bytes", async () => {
  const { db, call } = setup();
  expect((await call("/ext/resume")).status).toBe(404);
  const dir = mkdtempSync(path.join(tmpdir(), "ext-resume-"));
  const file = path.join(dir, "resume.pdf");
  writeFileSync(file, "%PDF-1.4 fake");
  saveProfile(db, { resumePath: file });
  const llm = (await call("/ext/status")).json();
  expect(await llm).toMatchObject({ profileComplete: true, hasResume: true });
  const res = await call("/ext/resume");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(decodeURIComponent(res.headers.get("x-filename")!)).toBe("Luis_Hernandez_Resume.pdf");
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.4 fake");
});

test("learn approves the named question, and words a new one through the classifier", async () => {
  const { db, call } = setup();
  const first = await call("/ext/resolve", { body: { url: "https://acme.test/apply", title: "Intern", company: "Acme", fields: [field("f2", "Phone")] } });
  const blocked = (await first.json() as ResolveResponse).resolutions[0]!;
  expect(blocked.status).toBe("needs-you");
  const qid = (blocked as { questionId: number }).questionId;

  const res = await call("/ext/learn", { body: { url: "https://acme.test/apply", company: "Acme", answers: [
    { label: "Phone", kind: "tel", value: "555 123 4567", source: "none", questionId: qid },
    { label: "Why do you want to work here?", kind: "textarea", value: "I love Acme's tools.", source: "none" },
    { label: "Text me about new roles", kind: "checkbox", value: true, source: "none" },
    { label: "Resume", kind: "file", value: "resume.pdf", source: "none" },
  ] } });
  expect(await res.json()).toEqual({ ok: true, learned: 2, overrides: 0 });
  expect(getQuestion(db, qid)).toMatchObject({ status: "approved", answer: "555 123 4567" });
  const why = listQuestions(db).find(q => q.canonical === "Why do you want to work at {company}?")!;
  // Company-specific: kept as a template, with the company's name replaced.
  expect(why).toMatchObject({ status: "approved", kind: "template", answer: "I love {company}'s tools.", variants: ["Why do you want to work here?"] });
  expect(listQuestions(db).some(q => q.canonical.includes("Text me"))).toBe(false);

  // The same phone label on the next form fills from the bank.
  const again = await call("/ext/resolve", { body: { url: "https://other.test/apply", title: "Intern", company: "Other", fields: [field("p", "Phone")] } });
  expect((await again.json() as ResolveResponse).resolutions[0]).toMatchObject({ status: "filled", answer: { type: "text", text: "555 123 4567" }, source: "bank" });
});

test("a question worded differently is filled from the answer the user typed before", async () => {
  const { db, llm, call } = setup();
  await call("/ext/learn", { body: { url: "https://acme.test/apply", company: "Acme", answers: [
    { label: "Tell us about a project you are proud of", kind: "textarea", value: "A ray tracer in Rust.", source: "none" },
  ] } });
  const saved = listQuestions(db).find(q => q.canonical === "Describe a project you are proud of.")!;
  expect(saved.status).toBe("approved");
  llm.on("match", () => ({ matchId: saved.id, confidence: "high" }));
  const res = await call("/ext/resolve", { body: { url: "https://beta.test/apply", title: "Intern", company: "Beta",
    fields: [field("x", "Describe a project you're proud of", "textarea")] } });
  expect((await res.json() as ResolveResponse).resolutions[0]).toMatchObject({ status: "filled", answer: { type: "text", text: "A ray tracer in Rust." }, source: "bank" });
});

test("learn on a known job saves per-job overrides, and a changed profile value stays with that job", async () => {
  const { db, call } = setup();
  const job = addJob(db, "https://jobs.ashbyhq.com/acme/0f0e-11aa");
  const res = await call("/ext/learn", { body: { url: "https://jobs.ashbyhq.com/acme/0f0e-11aa/application", answers: [
    { label: "First Name", kind: "text", value: "Lu", source: "profile" },
    { label: "Are you willing to relocate?", kind: "select", options: ["Yes", "No"], value: "Yes", source: "none" },
  ] } });
  expect(await res.json()).toEqual({ ok: true, learned: 1, overrides: 2 });
  expect(getOverrides(db, job.id)).toEqual({ "First Name": { type: "text", text: "Lu" }, "Are you willing to relocate?": { type: "option", option: "Yes" } });
  expect(listQuestions(db).map(q => q.canonical)).toEqual(["Are you willing to relocate?"]);
});

test("a submission on a known job marks it submitted and syncs the tracker", async () => {
  const { db, call, syncTracker, close } = setup();
  const job = addJob(db, "https://job-boards.greenhouse.io/acme/jobs/555");
  setStatus(db, job.id, "needs-you", "2 questions need you");
  const res = await call("/ext/submitted", { body: { url: "https://job-boards.greenhouse.io/acme/jobs/555?gh_src=x", title: "Intern", company: "Acme",
    resumeUsed: "Luis_Hernandez_Resume.pdf", answers: [{ label: "First Name", value: "Luis" }] } });
  expect(await res.json()).toEqual({ ok: true, jobId: job.id, created: false, already: false });
  expect(getJob(db, job.id)).toMatchObject({ status: "submitted", statusReason: "Submitted by you with the browser extension" });
  expect(getJob(db, job.id)!.submittedAt).not.toBeNull();
  expect(syncTracker).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith(job.id);
  // Sent twice (a retry after the page navigated): recorded once.
  expect(await (await call("/ext/submitted", { body: { url: "https://job-boards.greenhouse.io/acme/jobs/555", title: "Intern", company: "Acme" } })).json())
    .toMatchObject({ jobId: job.id, already: true });
  expect(syncTracker).toHaveBeenCalledTimes(1);
  expect(trackerRows(db).map(r => r[1])).toEqual(["Acme"]);
});

test("a submission on a page the app doesn't know adds a manual job row, shown in the tracker", async () => {
  const { db, call, syncTracker } = setup();
  const res = await call("/ext/submitted", { body: { url: "https://jobs.lever.co/zeta/9999-aaaa/apply", title: "Data Intern", company: "" } });
  const out = await res.json() as { jobId: string; created: boolean };
  expect(out.created).toBe(true);
  expect(getJob(db, out.jobId)).toMatchObject({ sourceId: "extension", company: "Zeta", title: "Data Intern", status: "submitted", ats: "lever" });
  expect(syncTracker).toHaveBeenCalledTimes(1);
  expect(trackerRows(db)[0]!.slice(1, 4)).toEqual(["Zeta", "Data Intern", "https://jobs.lever.co/zeta/9999-aaaa/apply"]);
  // The same page again finds that row.
  expect(await (await call("/ext/submitted", { body: { url: "https://jobs.lever.co/zeta/9999-aaaa/apply", title: "Data Intern", company: "" } })).json())
    .toMatchObject({ jobId: out.jobId, already: true });
});

test("bad bodies are refused", async () => {
  const { call } = setup();
  expect((await call("/ext/resolve", { body: { url: 3 } })).status).toBe(400);
  expect((await call("/ext/learn", { body: { url: "x", answers: [{ label: "a" }] } })).status).toBe(400);
});

test("postingKey and findJobByUrl match the same posting across URL forms", () => {
  expect(postingKey("https://job-boards.greenhouse.io/acme/jobs/123")).toBe("gh:123");
  expect(postingKey("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123")).toBe("gh:123");
  expect(postingKey("https://acme.com/careers?gh_jid=123")).toBe("gh:123");
  expect(postingKey("https://jobs.lever.co/acme/ABC-1/apply")).toBe("lever:abc-1");
  expect(postingKey("https://jobs.ashbyhq.com/acme/x-1/application")).toBe("ashby:x-1");
  expect(postingKey("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Austin-TX/Intern_R123/apply/applyManually")).toBe("wd:acme.wd5.myworkdayjobs.com:intern_r123");
  expect(postingKey("https://example.com/jobs/1")).toBeNull();
  const db = openDb(":memory:");
  const gh = addJob(db, "https://boards.greenhouse.io/acme/jobs/123");
  const other = addJob(db, "https://careers.example.com/roles/intern-42");
  expect(findJobByUrl(db, "https://acme.com/careers?gh_jid=123")?.id).toBe(gh.id);
  expect(findJobByUrl(db, "https://careers.example.com/roles/intern-42/apply?x=1")?.id).toBe(other.id);
  expect(findJobByUrl(db, "https://careers.example.com/roles/intern-4")).toBeNull();
  expect(findJobByUrl(db, "https://boards.greenhouse.io/acme/jobs/1234")).toBeNull();
});

test("Settings shows the pairing token, and a new token replaces it", async () => {
  const { db, app, token } = setup();
  const html = await (await app.request(`http://${HOST}/settings`, { headers: { host: HOST } })).text();
  expect(html).toContain("Browser extension");
  expect(html).toContain(token);
  expect(html).toContain("pnpm build:ext");
  const res = await app.request(`http://${HOST}/settings/extension-token`, { method: "POST", headers: { host: HOST, origin: `http://${HOST}` } });
  expect(res.status).toBe(303);
  expect(getExtToken(db)).not.toBe(token);
});

test("a draft for a choice field is offered as one of its options", async () => {
  const { db, llm, call } = setup();
  const q = createQuestion(db, { canonical: "Are you willing to relocate?", kind: "global", isFactual: true });
  setDraft(db, q.id, "yes");
  llm.on("match", () => ({ matchId: q.id, confidence: "high" }))
    .on("adapt", () => ({ option: "Yes", optionIndex: 0, index: 0, confident: true }));
  const res = await call("/ext/resolve", { body: { url: "https://acme.test/apply", title: "Intern", company: "Acme",
    fields: [field("r", "Are you willing to relocate?", "select", true, { options: ["Yes", "No"] })] } });
  const r = (await res.json() as ResolveResponse).resolutions[0]!;
  expect(r).toMatchObject({ status: "suggestion", text: "yes", questionId: q.id });
  expect((r as { suggestion: { type: string } }).suggestion.type).toBe("option");
});

test("SmartRecruiters: a one-click form is its own posting, named after its company, and found through the posting it came from", async () => {
  const oneclick = "https://jobs.smartrecruiters.com/oneclick-ui/company/LinkedIn3/publication/a65e1dba-0eed-486f-adf4-9e343a896901?dcr_ci=LinkedIn3";
  expect(postingKey(oneclick)).toBe("sr-pub:a65e1dba-0eed-486f-adf4-9e343a896901");
  expect(postingKey("https://jobs.smartrecruiters.com/oneclick-ui/company/LinkedIn3/publication/other-uuid")).toBe("sr-pub:other-uuid");
  expect(postingKey("https://jobs.smartrecruiters.com/LinkedIn3/744000158394370-software-engineer-intern")).toBe("sr:744000158394370");
  expect(companyFromUrl(oneclick)).toBe("LinkedIn3");
  expect(companyFromUrl("https://jobs.smartrecruiters.com/Intuitive/744000158313919")).toBe("Intuitive");

  const { db, call } = setup();
  const job = addJob(db, "https://jobs.smartrecruiters.com/LinkedIn3/744000158394370", "LinkedIn");
  expect(findJobByUrl(db, oneclick)).toBeNull();
  expect(findJobForPage(db, oneclick, "https://jobs.smartrecruiters.com/LinkedIn3/744000158394370")?.id).toBe(job.id);
  const res = await call("/ext/submitted", { body: { url: oneclick, referrer: "https://jobs.smartrecruiters.com/LinkedIn3/744000158394370", title: "Intern", company: "" } });
  expect(await res.json()).toMatchObject({ jobId: job.id, created: false });
  // Two one-click forms of different postings are two applications.
  const a = await (await call("/ext/submitted", { body: { url: "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/p-1", title: "A", company: "" } })).json() as { jobId: string; created: boolean };
  const b = await (await call("/ext/submitted", { body: { url: "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/p-2", title: "B", company: "" } })).json() as { jobId: string; created: boolean };
  expect([a.created, b.created]).toEqual([true, true]);
  expect(a.jobId).not.toBe(b.jobId);
  expect(getJob(db, a.jobId)?.company).toBe("Acme");
});
