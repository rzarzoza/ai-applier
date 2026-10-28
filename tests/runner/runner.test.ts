import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { openDb, type Db } from "../../src/db/db.js";
import { addBlocker, addNeedsYou, approveAnswer, blockersForJob, createQuestion, listOpenNeedsYou, listQuestions, setOverride } from "../../src/answers/bank.js";
import { paths } from "../../src/paths.js";
import { getJob, isUnknownSubmission, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { Job } from "../../src/jobs/types.js";
import { saveProfile, type Profile } from "../../src/profile/profile.js";
import { getRunnerHalt, getSettings, saveSettings } from "../../src/settings.js";
import type { Posting } from "../../src/sources/types.js";
import { persistentChromium, type BrowserProvider } from "../../src/runner/browser.js";
import { notificationScript } from "../../src/runner/notify.js";
import { listRecords } from "../../src/runner/records.js";
import type { Resolution } from "../../src/answers/resolve.js";
import type { FieldAnswer, FieldSpec } from "../../src/forms/types.js";
import { fillOrder, runJob, runNext, usedDocuments, type RunnerDeps } from "../../src/runner/runner.js";
import Anthropic from "@anthropic-ai/sdk";
import { canHandFinish, inboxItems } from "../../src/answers/inbox.js";
import { getRunnerCurrent } from "../../src/runner/current.js";
import { inPage } from "../../src/forms/in-page.js";
import { LlmOutputError } from "../../src/llm/llm.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { fixtureSubmitCount, miniAts, miniAtsHandler } from "../helpers/mini-ats-handler.js";

// --- a throwaway headless browser per run; every request not served by the mini handler is aborted ---
let browser: Browser;
let opened: { headless: boolean }[];
let lastPage: Page | null;
const provider: BrowserProvider = {
  async open(opts) {
    opened.push(opts);
    const context = await browser.newContext();
    await context.route("**/*", r => r.abort());
    const page = await context.newPage();
    lastPage = page;
    return { page, close: () => context.close() };
  },
};
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

// --- classification of the fixture's fields, keyed by label ---
type C = Record<string, unknown>;
const CLASSES: Record<string, C> = {
  "First Name": { category: "profile", profileKey: "firstName", isFactual: true },
  Email: { category: "profile", profileKey: "email", isFactual: true },
  Phone: { category: "profile", profileKey: "phone", isFactual: true },
  "Are you willing to relocate?": { category: "profile", profileKey: "willingToRelocate", isFactual: true },
  "Tell us about a project you are proud of": { category: "question", canonicalQuestion: "Describe a project you are proud of.", isFactual: false },
  "I certify that the information above is accurate": { category: "consent-required" },
  "Text me about new roles": { category: "optin-optional" },
  "Which cities would you consider?": { category: "derived", derivedKey: "jobLocation", isFactual: true },
  "Resume/CV": { category: "resume" },
  Transcript: { category: "question", canonicalQuestion: "Upload your transcript", isFactual: true },
};
const classifyBy = (overrides: Record<string, C> = {}) => (req: { content: unknown }) => ({
  fields: (JSON.parse(String(req.content)) as { fields: { id: string; label: string }[] }).fields.map(f => {
    const c = overrides[f.label] ?? CLASSES[f.label];
    if (!c) throw new Error(`test: no classification for "${f.label}"`);
    return { id: f.id, profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: false, isCompanySpecific: false, ...c };
  }),
});

let db: Db;
let llm: FakeLlm;
let notifications: { title: string; message: string }[];
let deps: RunnerDeps;
let job: Job;
let seq = 0;

const PROFILE: Partial<Profile> = { firstName: "Luis", lastName: "Hernandez", email: "luis@example.com", phone: "5551234567", willingToRelocate: true };

function addJob(url: string, extra: Partial<Posting> = {}): Job {
  const { job: j } = upsertPosting(db, {
    sourceId: "test", listingId: String(++seq), company: "Mini Co", title: "Software Engineer Intern", locations: ["Austin, TX"],
    category: "Software", terms: ["Summer 2027"], degrees: [], sponsorship: null, url, datePosted: new Date(), active: true, ...extra,
  });
  setStatus(db, j.id, "queued");
  return getJob(db, j.id)!;
}

const snapshotRow = (jobId: string) =>
  db.prepare("SELECT * FROM job_snapshots WHERE job_id = ?").get(jobId) as
    { fields_json: string; resolutions_json: string; screenshot_path: string | null; created_at: string } | undefined;

/** The failure left a screenshot on disk, referenced by the job's snapshot. */
const expectScreenshot = (jobId: string) => {
  const shot = snapshotRow(jobId)?.screenshot_path;
  expect(shot).toBeTruthy();
  expect(existsSync(shot!)).toBe(true);
};

beforeEach(() => {
  db = openDb(":memory:");
  saveProfile(db, PROFILE);
  llm = new FakeLlm()
    .on("classify", classifyBy())
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("draft", () => ({ answerable: false, draft: null }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
  notifications = [];
  opened = [];
  lastPage = null;
  miniAts.reset();
  deps = {
    db, llm, browser: provider, handlers: [miniAtsHandler], pollMs: 50, now: () => new Date(),
    notify: async (title, message) => { notifications.push({ title, message }); },
  };
  job = addJob("https://mini-ats.test/apply");
});

test("auto mode fills and submits; record saved", async () => {
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(listRecords(job.id)).toHaveLength(1);

  const after = getJob(db, job.id)!;
  expect(after).toMatchObject({ status: "submitted", attempts: 1, ats: "mini-ats" });
  expect(after.submittedAt).toBeInstanceOf(Date);
  expect(miniAts.submissions).toEqual([{ first: "Luis", email: "luis@example.com", phone: "5551234567", reloc: "y", project: "", certify: "on" }]);

  const dir = listRecords(job.id)[0]!;
  const record = JSON.parse(readFileSync(path.join(dir, "record.json"), "utf8"));
  expect(record.outcome).toBe("submitted");
  expect(record.answers).toEqual(expect.arrayContaining([
    { label: "Phone", value: "5551234567", source: "profile" },
    { label: "Are you willing to relocate?", value: "Yes", source: "profile" },
    { label: "I certify that the information above is accurate", value: true, source: "consent" },
  ]));
  expect(record.answers).toHaveLength(5); // the optional project question and SMS opt-in stay blank
  expect(readdirSync(dir).filter(f => f.endsWith(".png"))).toHaveLength(2); // filled form + confirmation
  expect(opened).toEqual([{ headless: false }]);
  expect(lastPage!.isClosed()).toBe(true);
});

test("review mode stops at ready-to-review without submitting", async () => {
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  expect(fixtureSubmitCount()).toBe(0);
  const snap = snapshotRow(job.id)!;
  expect(JSON.parse(snap.fields_json).map((f: { label: string }) => f.label)).toContain("Phone");
  expect(JSON.parse(snap.resolutions_json)).toHaveLength(7);
  expectScreenshot(job.id);
});

test("company review mode matches the company case-insensitively", async () => {
  saveSettings(db, { reviewMode: "companies", reviewCompanies: ["mini co"] });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  saveSettings(db, { reviewCompanies: ["Other Corp"] });
  expect(await runJob(deps, job.id)).toBe("submitted");
});

test("submit-reviewed submits a ready-to-review job and applies overrides", async () => {
  saveProfile(db, { phone: "555-ABC" }); // would fail validation without the override
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");

  setOverride(db, job.id, "Phone", { type: "text", text: "5550001111" });
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("submitted");
  expect(miniAts.submissions).toHaveLength(1);
  expect(miniAts.submissions[0]!.phone).toBe("5550001111");
  const record = JSON.parse(readFileSync(path.join(listRecords(job.id)[0]!, "record.json"), "utf8"));
  expect(record.answers).toContainEqual({ label: "Phone", value: "5550001111", source: "override" });
  expect(getJob(db, job.id)!.attempts).toBe(2);
});

test("submit-reviewed sends the reviewed values, not freshly resolved ones", async () => {
  saveSettings(db, { reviewMode: "all" });
  const t = createQuestion(db, { canonical: "Describe a project you are proud of.", kind: "template", isFactual: false });
  approveAnswer(db, t.id, "At {company} I would build tools.");
  llm.on("template", () => ({ text: "At Mini Co I would build tools." }));
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  // Values the user never reviewed: a new profile email and a regenerated template.
  saveProfile(db, { email: "changed@example.com" });
  llm.on("template", () => ({ text: "Something else entirely." }));
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ email: "luis@example.com", project: "At Mini Co I would build tools." });
});

test("submit-reviewed goes back to review when the form shows a value nobody reviewed", async () => {
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  // The form now reveals a follow-up question once relocation is answered.
  db.prepare("UPDATE jobs SET url = ? WHERE id = ?").run("https://mini-ats.test/apply?conditional=1", job.id);
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("ready-to-review");
  expect(getJob(db, job.id)!.statusReason).toBe("Form changed since review");
  expect(fixtureSubmitCount()).toBe(0);
  expect(JSON.parse(snapshotRow(job.id)!.fields_json).map((f: { label: string }) => f.label)).toContain("Which cities would you consider?");
  // Once that snapshot is reviewed, submitting sends it.
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ cities: "Austin, TX" });
});

test("submit-reviewed goes back to review when a field left blank at review now gets a value", async () => {
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  llm.on("classify", classifyBy({ "Text me about new roles": { category: "consent-required" } }));
  db.prepare("DELETE FROM field_cache").run();
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("ready-to-review");
  expect(getJob(db, job.id)!.statusReason).toBe("Form changed since review");
  expect(fixtureSubmitCount()).toBe(0);
});

test("a required file upload other than the resume fails the job without creating a question", async () => {
  const j = addJob("https://mini-ats.test/apply?file=Transcript");
  expect(await runJob(deps, j.id)).toBe("failed");
  expect(getJob(db, j.id)!.statusReason).toBe('Needs a file upload: "Transcript" — apply manually or skip');
  expect(listQuestions(db).filter(q => /transcript/i.test(q.canonical))).toEqual([]);
  expect(blockersForJob(db, j.id)).toEqual([]);
  expect(fixtureSubmitCount()).toBe(0);
});

test("a required resume upload with no resume waits for one, without creating a question", async () => {
  const j = addJob("https://mini-ats.test/apply?file=Resume%2FCV");
  expect(await runJob(deps, j.id)).toBe("needs-you");
  expect(getJob(db, j.id)!.statusReason).toBe("Upload your resume in Profile");
  expect(listQuestions(db).filter(q => /resume/i.test(q.canonical))).toEqual([]);
  expect(listOpenNeedsYou(db)).toMatchObject([{ jobId: j.id, kind: "other", message: expect.stringContaining("Upload your resume") }]);
  expect(fixtureSubmitCount()).toBe(0);

  // With a resume on file, the upload is filled from it.
  const resume = path.join(paths.dataDir, "resume-test.pdf");
  writeFileSync(resume, "%PDF-1.4 test");
  saveProfile(db, { resumePath: resume });
  setStatus(db, j.id, "queued");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(listOpenNeedsYou(db)).toEqual([]);
});

const withResume = () => {
  const resume = path.join(paths.dataDir, "resume-test.pdf");
  writeFileSync(resume, "%PDF-1.4 test");
  saveProfile(db, { resumePath: resume });
};

test("a resume parser that rewrites fields after the upload never overwrites the profile's answers", async () => {
  withResume();
  const j = addJob("https://mini-ats.test/apply?file=Resume%2FCV&parse=1");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(miniAts.submissions).toHaveLength(1);
  expect(miniAts.submissions[0]).toMatchObject({ first: "Luis", email: "luis@example.com", phone: "5551234567", reloc: "y" });

  // Stopping for review leaves the same intact values on the page.
  saveSettings(db, { reviewMode: "all" });
  const k = addJob("https://mini-ats.test/apply?file=Resume%2FCV&parse=1");
  const values: Record<string, string> = {};
  deps.handlers = [{
    ...miniAtsHandler,
    async readBack(page, field) {
      const got = await miniAtsHandler.readBack(page, field);
      if (typeof got === "string") values[field.label] = got;
      return got;
    },
  }];
  expect(await runJob(deps, k.id)).toBe("ready-to-review");
  expect(values).toMatchObject({ "First Name": "Luis", Email: "luis@example.com" });
});

test("the runner uploads the resume first, waits for the site, then fills the other fields", async () => {
  withResume();
  const order: string[] = [];
  deps.handlers = [{
    ...miniAtsHandler,
    async fill(page, field, answer) { order.push(field.label); return miniAtsHandler.fill(page, field, answer); },
    async afterUpload(page) { order.push("(after upload)"); return miniAtsHandler.afterUpload!(page); },
  }];
  const j = addJob("https://mini-ats.test/apply?file=Resume%2FCV");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(order).toEqual(["Resume/CV", "(after upload)", "First Name", "Email", "Phone", "Are you willing to relocate?",
    "I certify that the information above is accurate"]);

  // Without any upload, afterUpload is never called.
  order.length = 0;
  const k = addJob("https://mini-ats.test/apply");
  expect(await runJob(deps, k.id)).toBe("submitted");
  expect(order).not.toContain("(after upload)");
});

test("fillOrder puts the resume first, then other files, then every other field in form order", () => {
  const f = (id: string, kind: FieldSpec["kind"]): FieldSpec => ({ id, label: id, kind, required: false });
  const byId = new Map([f("name", "text"), f("cover", "file"), f("resume", "file"), f("why", "textarea")].map(x => [x.id, x]));
  const filled = (fieldId: string, answer: FieldAnswer, source: "resume" | "bank" | "profile") =>
    ({ fieldId, status: "filled" as const, answer, source });
  const plan = fillOrder(byId, [
    filled("name", { type: "text", text: "Luis" }, "profile"),
    filled("cover", { type: "file", path: "/data/cover.pdf" }, "bank"),
    filled("resume", { type: "file", path: "/data/resume.pdf" }, "resume"),
    filled("why", { type: "text", text: "Because" }, "bank"),
  ]);
  expect(plan.files.map(r => r.fieldId)).toEqual(["resume", "cover"]);
  expect(plan.rest.map(r => r.fieldId)).toEqual(["name", "why"]);
});

test("a value a late script clears after it was typed is filled once more before verifying", async () => {
  const fills: string[] = [];
  let cleared = false;
  deps.handlers = [{
    ...miniAtsHandler,
    async fill(page, field, answer) { fills.push(field.label); return miniAtsHandler.fill(page, field, answer); },
    async readBack(page, field) {
      // A parser that finishes late: it empties the first name just as the runner checks it.
      if (field.label === "First Name" && !cleared) { cleared = true; await page.locator("#first").fill(""); }
      return miniAtsHandler.readBack(page, field);
    },
  }];
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(fills.filter(l => l === "First Name")).toHaveLength(2);
  expect(fills.filter(l => l === "Email")).toHaveLength(1);
  expect(miniAts.submissions[0]).toMatchObject({ first: "Luis", email: "luis@example.com" });
});

test("unknown required question → needs-you with blocker; answered fields are filled, submit never clicked", async () => {
  saveProfile(db, { willingToRelocate: null });
  const fills: string[] = [];
  const read: Record<string, unknown> = {};
  let submits = 0;
  deps.handlers = [{
    ...miniAtsHandler,
    async fill(page, field, answer) { fills.push(field.label); return miniAtsHandler.fill(page, field, answer); },
    async readBack(page, field) { const got = await miniAtsHandler.readBack(page, field); read[field.label] = got; return got; },
    async submit(page) { submits++; return miniAtsHandler.submit(page); },
  }];
  expect(await runJob(deps, job.id)).toBe("needs-you");
  expect(submits).toBe(0);
  expect(blockersForJob(db, job.id)).toHaveLength(1);
  expect(fixtureSubmitCount()).toBe(0);
  expect(getJob(db, job.id)!.statusReason).toBe("1 question needs you");
  const [q] = listQuestions(db).filter(x => x.id === blockersForJob(db, job.id)[0]!.questionId);
  expect(q!.canonical).toBe("Are you willing to relocate?");
  // The blocker keeps the form's own field, so the inbox can offer this form's options.
  expect(inboxItems(db)[0]!.jobs).toEqual([{ id: job.id, company: "Mini Co", title: "Software Engineer Intern", url: job.url,
    label: "Are you willing to relocate?", kind: "select", options: expect.arrayContaining(["Yes", "No"]), description: null }]);
  expectScreenshot(job.id);
  expect(JSON.parse(snapshotRow(job.id)!.resolutions_json).filter((r: { status: string }) => r.status === "blocked")).toHaveLength(1);
  // Every answered field was typed (and checked), so the screenshot shows only the open question unanswered.
  expect(fills).toEqual(["First Name", "Email", "Phone", "I certify that the information above is accurate"]);
  expect(read).toMatchObject({ "First Name": "Luis", Email: "luis@example.com", Phone: "5551234567", "I certify that the information above is accurate": true });
  expect(read).not.toHaveProperty(["Are you willing to relocate?"]);
});

test("a blocked job with a resume upload still uploads it first and waits for the site, but never submits", async () => {
  withResume();
  saveProfile(db, { willingToRelocate: null });
  const order: string[] = [];
  let submits = 0;
  deps.handlers = [{
    ...miniAtsHandler,
    async fill(page, field, answer) { order.push(field.label); return miniAtsHandler.fill(page, field, answer); },
    async afterUpload(page) { order.push("(after upload)"); return miniAtsHandler.afterUpload!(page); },
    async submit(page) { submits++; return miniAtsHandler.submit(page); },
  }];
  const j = addJob("https://mini-ats.test/apply?file=Resume%2FCV&parse=1");
  expect(await runJob(deps, j.id)).toBe("needs-you");
  expect(order.slice(0, 3)).toEqual(["Resume/CV", "(after upload)", "First Name"]);
  expect(submits).toBe(0);
  expect(fixtureSubmitCount()).toBe(0);
});

test("unapproved draft blocks submission", async () => {
  llm.on("draft", () => ({ answerable: true, draft: "I built a compiler in Rust." }));
  expect(await runJob(deps, job.id)).toBe("needs-you");
  expect(blockersForJob(db, job.id)).toEqual([{ questionId: expect.any(Number), reason: "approval" }]);
  expect(fixtureSubmitCount()).toBe(0);
});

test("a required field with no answer fails without submitting", async () => {
  llm.on("classify", classifyBy({ "First Name": { category: "optin-optional" } }));
  expect(await runJob(deps, job.id)).toBe("failed");
  expect(getJob(db, job.id)!.statusReason).toBe('Required field "First Name" has no answer');
  expect(fixtureSubmitCount()).toBe(0);
  expectScreenshot(job.id);
});

test("a required field that will not keep its value fails without submitting", async () => {
  const j = addJob("https://mini-ats.test/apply?sabotage=1");
  expect(await runJob(deps, j.id)).toBe("failed");
  expect(getJob(db, j.id)!.statusReason).toBe('Could not fill "First Name"');
  expect(fixtureSubmitCount()).toBe(0);
  expectScreenshot(j.id);
});

/** Wraps the mini handler to record each field whose fill went through; `breaks` names fields whose fill throws. */
function recordingFills(breaks: Record<string, string> = {}) {
  const filledLabels: string[] = [];
  deps.handlers = [{
    ...miniAtsHandler,
    async fill(page, field, answer) {
      if (breaks[field.label]) throw new Error(breaks[field.label]);
      await miniAtsHandler.fill(page, field, answer);
      filledLabels.push(field.label);
    },
  }];
  return filledLabels;
}
const LATER_FIELDS = ["Email", "Phone", "Are you willing to relocate?", "I certify that the information above is accurate"];
const adaptOptions = () => llm.calls.filter(c => c.name === "adapt").map(c => (JSON.parse(String(c.content)) as { options: string[] }).options);

test("a field whose fill throws never stops the fields after it; a required one then fails the job with the reason", async () => {
  const filledLabels = recordingFills({ "First Name": "First name box is broken" });
  expect(await runJob(deps, job.id)).toBe("failed");
  expect(getJob(db, job.id)!.statusReason).toBe('Could not fill "First Name": First name box is broken');
  expect(filledLabels).toEqual(LATER_FIELDS);
  expect(fixtureSubmitCount()).toBe(0);
  expectScreenshot(job.id);
});

test("an optional field that cannot be filled is left blank and the job still submits", async () => {
  setOverride(db, job.id, "Tell us about a project you are proud of", { type: "text", text: "A compiler" });
  const filledLabels = recordingFills({ "Tell us about a project you are proud of": "Textarea detached" });
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(filledLabels).toEqual(["First Name", ...LATER_FIELDS]);
  expect(miniAts.submissions[0]).toMatchObject({ first: "Luis", project: "", certify: "on" });
  const record = JSON.parse(readFileSync(path.join(listRecords(job.id)[0]!, "record.json"), "utf8"));
  expect(record.answers.map((a: { label: string }) => a.label)).not.toContain("Tell us about a project you are proud of");
});

test("a combobox without the answer's option is read and the value mapped onto its real options; later fields are filled", async () => {
  saveProfile(db, { degree: "B.S." });
  llm.on("classify", classifyBy({ Degree: { category: "profile", profileKey: "degree", isFactual: true } }))
    .on("adapt", req => ({ option: (JSON.parse(String(req.content)) as { options: string[] }).options.includes("Bachelor's Degree") ? "Bachelor's Degree" : null }));
  const filledLabels = recordingFills();
  // Like Greenhouse's education selects: the form is read without the combobox's options.
  const handler = deps.handlers![0]!;
  deps.handlers = [{ ...handler, async readFields(page) {
    const fields = await miniAtsHandler.readFields(page);
    for (const f of fields) if (f.label === "Degree") delete f.options;
    return fields;
  } }];
  const j = addJob("https://mini-ats.test/apply?degree=1");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(adaptOptions()).toEqual([["Associate's Degree", "Bachelor's Degree", "Master's Degree"]]);
  expect(filledLabels).toEqual(["First Name", "Degree", ...LATER_FIELDS]);
  expect(miniAts.submissions).toEqual([{ first: "Luis", degree: "Bachelor's Degree", email: "luis@example.com", phone: "5551234567", reloc: "y", project: "", certify: "on" }]);
  const record = JSON.parse(readFileSync(path.join(listRecords(j.id)[0]!, "record.json"), "utf8"));
  expect(record.answers).toContainEqual({ label: "Degree", value: "Bachelor's Degree", source: "profile" });
});

test("a combobox value no real option matches fails the job naming the field, after every later field was filled", async () => {
  saveProfile(db, { degree: "B.S." });
  llm.on("classify", classifyBy({ Degree: { category: "profile", profileKey: "degree", isFactual: true } }))
    .on("adapt", () => ({ option: null }));
  const filledLabels = recordingFills();
  // A lazy list shows nothing until something is typed: the value's first letter loads the options.
  const j = addJob("https://mini-ats.test/apply?degree=1&lazy=1");
  expect(await runJob(deps, j.id)).toBe("failed");
  expect(getJob(db, j.id)!.statusReason).toBe('Could not fill "Degree": no option matches "B.S."');
  expect(adaptOptions()).toEqual([["Bachelor's Degree"]]);
  expect(filledLabels).toEqual(["First Name", ...LATER_FIELDS]);
  expect(fixtureSubmitCount()).toBe(0);
  expectScreenshot(j.id);
});

test("a blocked job fills every field it can: one that cannot be filled is left blank and the job still needs you", async () => {
  saveProfile(db, { degree: "B.S.", willingToRelocate: null });
  llm.on("classify", classifyBy({ Degree: { category: "profile", profileKey: "degree", isFactual: true } }))
    .on("adapt", () => ({ option: null }));
  const filledLabels = recordingFills();
  const j = addJob("https://mini-ats.test/apply?degree=1&lazy=1");
  expect(await runJob(deps, j.id)).toBe("needs-you");
  expect(getJob(db, j.id)!.statusReason).toBe("1 question needs you");
  expect(filledLabels).toEqual(["First Name", "Email", "Phone", "I certify that the information above is accurate"]);
  expect(fixtureSubmitCount()).toBe(0);
});

test("validation error after submit → failed with page messages", async () => {
  saveProfile(db, { phone: "555-ABC" });
  expect(await runJob(deps, job.id)).toBe("failed");
  expect(getJob(db, job.id)!.statusReason).toContain("Invalid phone");
  expect(fixtureSubmitCount()).toBe(0);
  expectScreenshot(job.id);
});

test("an unknown outcome, or no confirmation in time, ends needs-you (state unknown), never failed", async () => {
  const oops = addJob("https://mini-ats.test/apply?oops=1");
  expect(await runJob(deps, oops.id)).toBe("needs-you");
  expect(getJob(db, oops.id)!.statusReason).toBe("Submission state unknown — check before retrying");
  expect(listOpenNeedsYou(db).map(n => n.message).join("\n")).toContain("Something went wrong on our side");
  expectScreenshot(oops.id);

  const silent = addJob("https://mini-ats.test/apply?silent=1");
  expect(await runJob({ ...deps, submitWaitMs: 300 }, silent.id)).toBe("needs-you");
  expect(getJob(db, silent.id)!.statusReason).toBe("Submission state unknown — check before retrying");
  expectScreenshot(silent.id);
});

test("an outcome check that throws mid-navigation counts as pending", async () => {
  miniAts.outcomeErrors = 2;
  expect(await runJob(deps, job.id)).toBe("submitted");
});

test("daily limit leaves job queued", async () => {
  saveSettings(db, { dailyLimit: 1 });
  const done = addJob("https://mini-ats.test/apply?earlier=1");
  setStatus(db, done.id, "submitted");

  expect(await runJob(deps, job.id)).toBe("queued");
  expect(getJob(db, job.id)!.status).toBe("queued");
  expect(fixtureSubmitCount()).toBe(0);
  expect(await runNext(deps)).toBeNull();
  expect(getJob(db, job.id)!.status).toBe("queued");
});

test("captcha: notifies, waits, then needs-you after humanWaitMs", async () => {
  const captchaJob = addJob("https://mini-ats.test/apply?captcha=1");
  expect(await runJob({ ...deps, humanWaitMs: 300, pollMs: 50 }, captchaJob.id)).toBe("needs-you");
  expect(notifications).toHaveLength(1);
  expect(listOpenNeedsYou(db)[0]!.kind).toBe("captcha");
  expect(getJob(db, captchaJob.id)!.statusReason).toBe("CAPTCHA");
  expect(fixtureSubmitCount()).toBe(0);
});

test("captcha solved by the user while waiting → submitted and needs-you resolved", async () => {
  const captchaJob = addJob("https://mini-ats.test/apply?captcha=1");
  const solving = { ...deps, humanWaitMs: 10_000, notify: async (title: string, message: string) => {
    notifications.push({ title, message });
    setTimeout(() => void lastPage!.locator("#solve").click(), 100);
  } };
  expect(await runJob(solving, captchaJob.id)).toBe("submitted");
  expect(notifications).toHaveLength(1);
  expect(listOpenNeedsYou(db)).toEqual([]);
  expect(listRecords(captchaJob.id)).toHaveLength(1);
});

test("interactive and submit-reviewed open a visible browser; interactive still stops for review", async () => {
  saveSettings(db, { headless: true, reviewMode: "all" });
  expect(await runJob(deps, job.id, "interactive")).toBe("ready-to-review");
  expect(fixtureSubmitCount()).toBe(0);
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("submitted");
  saveSettings(db, { reviewMode: "off" });
  const other = addJob("https://mini-ats.test/apply?other=1");
  expect(await runJob(deps, other.id)).toBe("submitted");
  expect(opened).toEqual([{ headless: false }, { headless: false }, { headless: true }]);
});

test("jobs that are done or set aside are never run again", async () => {
  for (const status of ["submitted", "applied-manually", "closed", "skipped", "duplicate-role"] as const) {
    setStatus(db, job.id, status, "kept");
    for (const mode of ["auto", "interactive", "submit-reviewed"] as const) {
      expect(await runJob(deps, job.id, mode), `${status}/${mode}`).toBe(status);
    }
    expect(getJob(db, job.id), status).toMatchObject({ status, statusReason: "kept", attempts: 0 });
  }
  expect(opened).toEqual([]);
  expect(fixtureSubmitCount()).toBe(0);
});

test("submit-reviewed only runs a job that is awaiting review", async () => {
  for (const status of ["queued", "needs-you", "failed"] as const) {
    setStatus(db, job.id, status, "kept");
    expect(await runJob(deps, job.id, "submit-reviewed"), status).toBe(status);
  }
  expect(opened).toEqual([]);
  expect(getJob(db, job.id)!.attempts).toBe(0);
});

test("headless captcha goes straight to needs-you without waiting", async () => {
  saveSettings(db, { headless: true });
  const captchaJob = addJob("https://mini-ats.test/apply?captcha=1");
  const started = Date.now();
  expect(await runJob({ ...deps, humanWaitMs: 20_000 }, captchaJob.id)).toBe("needs-you");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(notifications).toHaveLength(1);
  expect(listOpenNeedsYou(db).map(n => n.kind)).toEqual(["captcha"]);
  expect(getJob(db, captchaJob.id)!.statusReason).toBe("CAPTCHA");
});

test("captcha cleared but no confirmation after the wait → state unknown, never a plain CAPTCHA retry", async () => {
  const captchaJob = addJob("https://mini-ats.test/apply?captcha=1");
  const clearing = { ...deps, humanWaitMs: 400, notify: async () => {
    // The challenge goes away but the page never confirms (as if the user submitted elsewhere).
    setTimeout(() => void lastPage!.evaluate(inPage(() => { document.getElementById("challenge")!.hidden = true; }), undefined), 50);
  } };
  expect(await runJob(clearing, captchaJob.id)).toBe("needs-you");
  expect(getJob(db, captchaJob.id)!.statusReason).toBe("Submission state unknown — check before retrying");
  expect(listOpenNeedsYou(db).map(n => n.kind)).toEqual(["other"]);
});

test("a browser window closed during the human wait stops waiting and ends state unknown", async () => {
  const captchaJob = addJob("https://mini-ats.test/apply?captcha=1");
  const closing = { ...deps, humanWaitMs: 20_000, notify: async () => { setTimeout(() => void lastPage!.close(), 100); } };
  const started = Date.now();
  expect(await runJob(closing, captchaJob.id)).toBe("needs-you");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(getJob(db, captchaJob.id)!.statusReason).toBe("Submission state unknown — check before retrying");
  expect(listOpenNeedsYou(db).map(n => n.message).join()).toContain("window was closed");
});

test("interactive mode never re-runs a possibly sent application", async () => {
  setStatus(db, job.id, "needs-you", "Submission state unknown — check before retrying");
  expect(await runJob(deps, job.id, "interactive")).toBe("needs-you");
  expect(opened).toEqual([]);
  expect(getJob(db, job.id)!.attempts).toBe(0);
  expect(fixtureSubmitCount()).toBe(0);
});

test("a run ending in any status but needs-you resolves the job's open needs-you items", async () => {
  addNeedsYou(db, { jobId: job.id, kind: "captcha", message: "old captcha" });
  const failing = addJob("https://mini-ats.test/gone");
  addNeedsYou(db, { jobId: failing.id, kind: "captcha", message: "old captcha" });
  setStatus(db, job.id, "needs-you", "CAPTCHA");
  setStatus(db, failing.id, "needs-you", "CAPTCHA");
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id, "interactive")).toBe("ready-to-review");
  expect(await runJob(deps, failing.id, "interactive")).toBe("failed");
  expect(db.prepare("SELECT COUNT(*) AS n FROM needs_you WHERE resolved = 0").get()).toEqual({ n: 0 });
});

test("submit-reviewed waits for the user past humanWaitMs", async () => {
  saveSettings(db, { reviewMode: "all" });
  const captchaJob = addJob("https://mini-ats.test/apply?captcha=1");
  expect(await runJob(deps, captchaJob.id)).toBe("ready-to-review");
  const solving = { ...deps, humanWaitMs: 50, notify: async (title: string, message: string) => {
    notifications.push({ title, message });
    setTimeout(() => void lastPage!.locator("#solve").click(), 500);
  } };
  expect(await runJob(solving, captchaJob.id, "submit-reviewed")).toBe("submitted");
  expect(listOpenNeedsYou(db)).toEqual([]);
});

test("a run replaces stale blockers; a submission resolves open needs-you items", async () => {
  const stale = createQuestion(db, { canonical: "An old question", kind: "global", isFactual: true });
  addBlocker(db, job.id, stale.id, "missing");
  saveProfile(db, { willingToRelocate: null });
  expect(await runJob(deps, job.id)).toBe("needs-you");
  const blockers = blockersForJob(db, job.id);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]!.questionId).not.toBe(stale.id);

  saveProfile(db, { willingToRelocate: true });
  addNeedsYou(db, { jobId: job.id, kind: "captcha", message: "old captcha" });
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(blockersForJob(db, job.id)).toEqual([]);
  expect(listOpenNeedsYou(db)).toEqual([]);
});

test("a record that cannot be written never turns a submission into a failure", async () => {
  mkdirSync(paths.records, { recursive: true });
  writeFileSync(path.join(paths.records, job.id), "a file where the job's record folder should be");
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(fixtureSubmitCount()).toBe(1);
  expect(getJob(db, job.id)!.statusReason).toMatch(/^Submitted, but the record could not be saved/);
});

test("an error after clicking submit ends needs-you, never plain failed", async () => {
  miniAts.submitThrows = true;
  const silent = addJob("https://mini-ats.test/apply?silent=1");
  expect(await runJob(deps, silent.id)).toBe("needs-you");
  expect(getJob(db, silent.id)!.statusReason).toBe("Submission state unknown — check before retrying");
  expect(listOpenNeedsYou(db).map(n => n.kind)).toEqual(["other"]);
  expectScreenshot(silent.id);
});

test("questions revealed by an answer are resolved and filled before submitting", async () => {
  const cond = addJob("https://mini-ats.test/apply?conditional=1");
  expect(await runJob(deps, cond.id)).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ reloc: "y", cities: "Austin, TX" });
  const record = JSON.parse(readFileSync(path.join(listRecords(cond.id)[0]!, "record.json"), "utf8"));
  expect(record.answers).toContainEqual({ label: "Which cities would you consider?", value: "Austin, TX", source: "derived" });
});

test("a revealed required question nobody can answer blocks the job", async () => {
  llm.on("classify", classifyBy({ "Which cities would you consider?": { category: "question", canonicalQuestion: "Which cities would you consider?", isFactual: true } }));
  const cond = addJob("https://mini-ats.test/apply?conditional=1");
  expect(await runJob(deps, cond.id)).toBe("needs-you");
  expect(getJob(db, cond.id)!.statusReason).toBe("1 question needs you");
  expect(blockersForJob(db, cond.id)).toHaveLength(1);
  expect(fixtureSubmitCount()).toBe(0);
});

test("open failures map to closed, failed or applied-manually; zero fields fails", async () => {
  const cases: [string, string, string][] = [
    ["/closed", "closed", "job is no longer accepting applications"],
    ["/gone", "failed", "HTTP 404"],
    ["/applied", "applied-manually", "you already applied"],
    ["/blocked", "failed", "Blocked: bot wall (HTTP 403)"],
    ["/throw", "failed", "net::ERR_CONNECTION_RESET"],
    ["/empty", "failed", "No form fields found"],
  ];
  for (const [p, status, reason] of cases) {
    const j = addJob(`https://mini-ats.test${p}`);
    expect(await runJob(deps, j.id), p).toBe(status);
    expect(getJob(db, j.id)!.statusReason, p).toBe(reason);
    expectScreenshot(j.id);
  }
  expect(fixtureSubmitCount()).toBe(0);
});

test("unsupported ATS → unsupported with ats name", async () => {
  const wd = addJob("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Intern_R1");
  expect(await runJob(deps, wd.id)).toBe("unsupported");
  expect(getJob(db, wd.id)).toMatchObject({ status: "unsupported", statusReason: "workday", ats: "workday" });
  expect(opened).toEqual([]);
});

test("runNext returns null when paused", async () => {
  saveSettings(db, { paused: true });
  expect(await runNext(deps)).toBeNull();
  expect(getJob(db, job.id)!.status).toBe("queued");
  saveSettings(db, { paused: false });
  expect(await runNext(deps)).toBe("submitted");
  expect(await runNext(deps)).toBeNull(); // nothing left in the queue
});

test("API-wide LLM errors put the job back and pause the runner instead of failing it", async () => {
  const cases: [Error, RegExp][] = [
    [new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers()), /rejected the API key/],
    [new Anthropic.PermissionDeniedError(403, undefined, "forbidden", new Headers()), /denied access/],
    [new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()), /rate limit/],
    [new Anthropic.APIConnectionError({ message: "fetch failed" }), /Can't reach the Anthropic API/],
    [new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers()), /overloaded/],
    [new Error("Could not resolve authentication method. Expected one of apiKey..."), /Add your Anthropic API key/],
  ];
  for (const [err, reason] of cases) {
    saveSettings(db, { paused: false });
    llm.on("classify", () => { throw err; });
    expect(await runNext(deps), err.message).toBe("queued");
    expect(getJob(db, job.id), err.message).toMatchObject({ status: "queued", attempts: 0 });
    expect(getSettings(db).paused).toBe(true);
    expect(getRunnerHalt(db)?.reason).toMatch(reason);
    expect(await runNext(deps)).toBeNull(); // paused: the queue waits
  }
  expect(fixtureSubmitCount()).toBe(0);
});

test("a halted review submission goes back to ready-to-review", async () => {
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  llm.on("classify", () => { throw new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()); });
  // Classifications are cached; clear them so this run asks the LLM again.
  db.prepare("DELETE FROM field_cache").run();
  expect(await runJob(deps, job.id, "submit-reviewed")).toBe("ready-to-review");
  expect(getJob(db, job.id)).toMatchObject({ status: "ready-to-review", statusReason: "Waiting for your review", attempts: 1 });
});

test("a browser that can't start pauses the runner and keeps the job queued", async () => {
  const broken: BrowserProvider = { open: async () => { throw new Error("browserType.launchPersistentContext: Executable doesn't exist at /x/chrome\nmore"); } };
  expect(await runNext({ ...deps, browser: broken })).toBe("queued");
  expect(getJob(db, job.id)).toMatchObject({ status: "queued", attempts: 0 });
  expect(getRunnerHalt(db)?.reason).toBe("The browser could not start: browserType.launchPersistentContext: Executable doesn't exist at /x/chrome");
  expect(getSettings(db).paused).toBe(true);
});

test("an error that belongs to one job still fails only that job", async () => {
  llm.on("classify", () => { throw new LlmOutputError('No parsed output for "classify"'); });
  expect(await runNext(deps)).toBe("failed");
  expect(getSettings(db).paused).toBe(false);
  expect(getRunnerHalt(db)).toBeNull();
});

test("runNext skips queued jobs that no longer pass the filters and runs the next one", async () => {
  const toronto = addJob("https://mini-ats.test/apply?toronto=1", { company: "Other Co", locations: ["Toronto, ON, Canada"], datePosted: new Date(Date.now() + 60_000) });
  expect(await runNext(deps)).toBe("submitted");
  expect(getJob(db, toronto.id)).toMatchObject({ status: "skipped", statusReason: expect.stringContaining("Canada"), attempts: 0 });
  expect(getJob(db, job.id)!.status).toBe("submitted");
  expect(miniAts.submissions).toHaveLength(1);
});

test("posting age is an intake rule: an old queued job still runs", async () => {
  db.prepare("UPDATE jobs SET date_posted = ? WHERE id = ?").run(new Date(Date.now() - 20 * 86_400_000).toISOString(), job.id);
  expect(await runNext(deps)).toBe("submitted");
});

test("runNext with no API key pauses instead of taking a job", async () => {
  expect(await runNext({ ...deps, hasApiKey: async () => false })).toBeNull();
  expect(opened).toEqual([]);
  expect(getJob(db, job.id)).toMatchObject({ status: "queued", attempts: 0 });
  expect(getSettings(db).paused).toBe(true);
  expect(getRunnerHalt(db)?.reason).toBe("Add your Anthropic API key in Settings");
  saveSettings(db, { paused: false });
  expect(await runNext({ ...deps, hasApiKey: async () => true })).toBe("submitted");
});

test("notification script quotes title and message for AppleScript", () => {
  expect(notificationScript('Say "hi"', "back\\slash")).toBe('display notification "back\\\\slash" with title "Say \\"hi\\""');
});

test("persistent Chromium opens a page in the profile directory and closes", async () => {
  const { page, close } = await persistentChromium.open({ headless: true });
  await page.setContent("<p>ok</p>");
  expect(await page.locator("p").innerText()).toBe("ok");
  await close();
  expect(page.isClosed()).toBe(true);
});

test("runner records resume_used and cover_letter_used on submit and calls onSubmitted", async () => {
  const seen: string[] = [];
  deps.onSubmitted = id => { seen.push(id); };
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(seen).toEqual([job.id]);
  expect(db.prepare("SELECT resume_used, cover_letter_used FROM jobs WHERE id = ?").get(job.id)).toEqual({ resume_used: null, cover_letter_used: "none" });
  // A throwing hook never changes the outcome.
  const j2 = addJob("https://mini-ats.test/apply");
  deps.onSubmitted = () => { throw new Error("boom"); };
  expect(await runJob(deps, j2.id)).toBe("submitted");
});

test("usedDocuments picks the resume by source and cover letters by label", () => {
  const f = (id: string, label: string): FieldSpec => ({ id, label, kind: "file", required: false });
  const filled = (fieldId: string, answer: FieldAnswer, source: "resume" | "bank" | "profile"): Resolution => ({ fieldId, status: "filled", answer, source });
  const fields = [f("1", "Resume/CV"), f("2", "Cover Letter"), f("3", "Other file")];
  expect(usedDocuments(fields, [
    filled("1", { type: "file", path: "/data/resume.pdf" }, "resume"),
    filled("2", { type: "file", path: "/x/My Cover.pdf" }, "bank"),
  ])).toEqual({ resume: "resume.pdf", coverLetter: "My Cover.pdf" });
  const text: FieldSpec = { id: "4", label: "Why us? (cover letter)", kind: "textarea", required: false };
  expect(usedDocuments([text], [filled("4", { type: "text", text: "hi" }, "bank")])).toEqual({ resume: null, coverLetter: "written answer" });
  expect(usedDocuments([], [])).toEqual({ resume: null, coverLetter: "none" });
});

// --- "Other → type the real value": a name the list truly lacks picks "Other" and is typed into the box for it ---

const SCHOOL_CLASS = { School: { category: "profile", profileKey: "school", isFactual: true } };
/** The fake LLM maps a stored school onto a listed option naming Rice, else on none. */
const riceAdapt = (req: { content: unknown }) => ({
  option: (JSON.parse(String(req.content)) as { options: string[] }).options.find(o => /^rice/i.test(o)) ?? null,
});
const classifiedLabels = () => llm.calls.filter(c => c.name === "classify")
  .flatMap(c => (JSON.parse(String(c.content)) as { fields: { label: string }[] }).fields.map(f => f.label));
/** Wraps the mini handler to record every answer a fill was attempted with, by label. */
function recordingAttempts() {
  const attempts: { label: string; answer: FieldAnswer }[] = [];
  deps.handlers = [{ ...miniAtsHandler, async fill(page, field, answer) {
    attempts.push({ label: field.label, answer });
    await miniAtsHandler.fill(page, field, answer);
  } }];
  return attempts;
}
const picked = (attempts: { label: string; answer: FieldAnswer }[], label: string) =>
  attempts.filter(a => a.label === label).map(a => (a.answer.type === "option" ? a.answer.option : a.answer.type === "text" ? a.answer.text : null));

/** The applicant studies at Rice; the fake LLM classifies "School" as the profile's school. */
function riceSetup() {
  saveProfile(db, { school: "Rice University" });
  llm.on("classify", classifyBy(SCHOOL_CLASS)).on("adapt", riceAdapt).on("variants", () => ({ variants: ["William Marsh Rice University"] }));
}

test("a school combobox without the user's school picks Other and types the school into the box it reveals; later fields are filled", async () => {
  riceSetup();
  const attempts = recordingAttempts();
  const j = addJob("https://mini-ats.test/apply?school=combo");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(miniAts.submissions).toEqual([{
    first: "Luis", school: "Other", school_other: "Rice University", email: "luis@example.com", phone: "5551234567", reloc: "y", project: "", certify: "on",
  }]);
  // Searched with the whole name, its distinctive word and the LLM's variant before falling back.
  const searches = llm.calls.filter(c => c.name === "variants");
  expect(searches).toHaveLength(1);
  expect(picked(attempts, "School")).toEqual(["Rice University", "Other"]);
  expect(classifiedLabels()).not.toContain("Please specify your school"); // claimed, never a new question
  const record = JSON.parse(readFileSync(path.join(listRecords(j.id)[0]!, "record.json"), "utf8"));
  expect(record.answers).toEqual(expect.arrayContaining([
    { label: "School", value: "Other", source: "profile" },
    { label: "School (other)", value: "Rice University", source: "profile" },
  ]));
  expect(getJob(db, j.id)!.statusReason).toBeNull();
});

test("a native select with 'Other (please specify)' and an 'If other' box already there: Other is picked, the box gets the school; review then submit", async () => {
  riceSetup();
  saveSettings(db, { reviewMode: "all" });
  const j = addJob("https://mini-ats.test/apply?school=select");
  expect(await runJob(deps, j.id)).toBe("ready-to-review");
  expect(getJob(db, j.id)!.statusReason).toBe("Waiting for your review");
  expect(classifiedLabels()).not.toContain("If other, school name");
  const snap = snapshotRow(j.id)!;
  const fields = JSON.parse(snap.fields_json) as FieldSpec[];
  const resolutions = JSON.parse(snap.resolutions_json) as Resolution[];
  const by = (label: string) => resolutions.find(r => r.fieldId === fields.find(f => f.label === label)?.id);
  expect(by("School")).toMatchObject({ status: "filled", answer: { type: "option", option: "Other (please specify)" }, other: "Rice University", source: "profile" });
  expect(by("School (other)")).toMatchObject({ status: "filled", answer: { type: "text", text: "Rice University" }, source: "profile" });

  expect(await runJob(deps, j.id, "submit-reviewed")).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ school: "Other (please specify)", school_other: "Rice University", email: "luis@example.com", certify: "on" });
});

test("a lazy list that only shows Other once 'Other' is typed: searched first, then Other is picked and the box filled", async () => {
  riceSetup();
  const attempts = recordingAttempts();
  const j = addJob("https://mini-ats.test/apply?school=lazy");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ school: "Other", school_other: "Rice University", email: "luis@example.com", certify: "on" });
  expect(picked(attempts, "School")).toEqual(["Rice University", "Other"]);
  // "R" alone shows 5 schools; the searches for "Rice University", "Rice" and the variant surfaced nothing more.
  expect(adaptOptions()).toEqual([["Radford University", "Ramapo College", "Reed College", "Regis University", "Rensselaer Polytechnic Institute"]]);
});

test("a school only found by searching its distinctive word (the first letter's list is cut short) is chosen, never Other", async () => {
  riceSetup();
  const attempts = recordingAttempts();
  const j = addJob("https://mini-ats.test/apply?school=lazy&rice=1");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ school: "Rice Univ. (Houston, TX)", email: "luis@example.com" });
  expect(miniAts.submissions[0]).not.toHaveProperty("school_other");
  expect(picked(attempts, "School")).toEqual(["Rice University", "Rice Univ. (Houston, TX)"]);
  expect(adaptOptions()[0]).toContain("Rice Univ. (Houston, TX)");
});

test("a list with both the school and Other picks the school", async () => {
  riceSetup();
  const attempts = recordingAttempts();
  const j = addJob("https://mini-ats.test/apply?school=both");
  expect(await runJob(deps, j.id)).toBe("submitted");
  expect(miniAts.submissions[0]).toMatchObject({ school: "Rice University" });
  expect(picked(attempts, "School")).toEqual(["Rice University"]);
});

test("a required school with Other but no box to type in keeps Other and says so in the job's reason", async () => {
  riceSetup();
  saveSettings(db, { reviewMode: "all" });
  const j = addJob("https://mini-ats.test/apply?school=nobox");
  expect(await runJob(deps, j.id)).toBe("ready-to-review");
  expect(getJob(db, j.id)!.statusReason).toBe('Waiting for your review; Picked Other for School ("Rice University" not listed)');
  const snap = snapshotRow(j.id)!;
  const fields = JSON.parse(snap.fields_json) as FieldSpec[];
  const school = (JSON.parse(snap.resolutions_json) as Resolution[]).find(r => r.fieldId === fields.find(f => f.label === "School")!.id);
  expect(school).toMatchObject({ status: "filled", answer: { type: "option", option: "Other" }, other: "Rice University" });
  expect(fields.map(f => f.label)).not.toContain("School (other)");
});

test("a work-authorization question offering Other never picks it, even when the answer is not listed", async () => {
  riceSetup();
  const AUTH = "Are you authorized to work in the US?";
  const q = createQuestion(db, { canonical: AUTH, kind: "global", isFactual: true });
  approveAnswer(db, q.id, "Authorized via OPT");
  llm.on("classify", classifyBy({ ...SCHOOL_CLASS, [AUTH]: { category: "question", canonicalQuestion: AUTH, isFactual: true } }))
    .on("match", () => ({ matchId: q.id, confidence: "high" }))
    .on("adapt", () => ({ option: null }));
  const attempts = recordingAttempts();
  // Read without its options (like an async select), so the stored answer is typed and the runner recovers.
  const base = deps.handlers![0]!;
  deps.handlers = [{ ...base, async readFields(page) {
    const fields = await miniAtsHandler.readFields(page);
    for (const f of fields) if (f.label === AUTH) delete f.options;
    return fields;
  } }];
  const j = addJob("https://mini-ats.test/apply?auth=1");
  expect(await runJob(deps, j.id)).toBe("failed");
  expect(getJob(db, j.id)!.statusReason).toBe(`Could not fill "${AUTH}": no option matches "Authorized via OPT"`);
  expect(picked(attempts, AUTH)).toEqual(["Authorized via OPT"]);
  expect(llm.calls.filter(c => c.name === "variants")).toHaveLength(0);
  expect(fixtureSubmitCount()).toBe(0);
});

// --- the dashboard's "Applying now" step tracking ---

test("the runner records its current job and step while it runs, and clears them at the end", async () => {
  const seen: (string | undefined)[] = [];
  const at = () => { const c = getRunnerCurrent(db); seen.push(c?.step); expect(c?.jobId).toBe(job.id); };
  llm.on("classify", req => { at(); return classifyBy()(req); });
  deps.handlers = [{
    ...miniAtsHandler,
    async open(page, url) { at(); return miniAtsHandler.open(page, url); },
    async readFields(page) { at(); return miniAtsHandler.readFields(page); },
    async fill(page, field, answer) { at(); return miniAtsHandler.fill(page, field, answer); },
    async readBack(page, field) { at(); return miniAtsHandler.readBack(page, field); },
    async submit(page) { at(); return miniAtsHandler.submit(page); },
    async outcome(page) { at(); return miniAtsHandler.outcome(page); },
  }];
  expect(await runJob(deps, job.id)).toBe("submitted");
  const steps = seen.filter((s, i) => s !== seen[i - 1]);
  expect(steps).toEqual(["Opening application", "Reading the form", "Working out answers", "Filling fields", "Checking answers",
    "Submitting", "Waiting for confirmation"]);
  expect(getRunnerCurrent(db)).toBeNull();
  expect(db.prepare("SELECT 1 FROM kv WHERE key = 'runnerCurrent'").get()).toBeUndefined();
});

test("the current step is cleared even when a run fails, and the resume upload and human wait have their own steps", async () => {
  const failing = addJob("https://mini-ats.test/empty");
  expect(await runJob(deps, failing.id)).toBe("failed");
  expect(getRunnerCurrent(db)).toBeNull();

  withResume();
  const steps: string[] = [];
  const captchaJob = addJob("https://mini-ats.test/apply?file=Resume%2FCV&captcha=1");
  deps.handlers = [{ ...miniAtsHandler, async afterUpload(page) { steps.push(getRunnerCurrent(db)!.step); return miniAtsHandler.afterUpload!(page); } }];
  const run = { ...deps, humanWaitMs: 400, notify: async () => { setTimeout(() => steps.push(getRunnerCurrent(db)!.step), 100); } };
  expect(await runJob(run, captchaJob.id)).toBe("needs-you");
  expect(steps).toEqual(["Uploading resume", "Waiting for you (CAPTCHA/code)"]);
  expect(getRunnerCurrent(db)).toBeNull();
});

// --- "Open & finish": the user completes a needs-you form by hand ---

/** Resolves once the run is waiting for the user to finish the form. */
async function untilWaitingForUser(jobId: string): Promise<Page> {
  for (let i = 0; i < 400; i++) {
    const c = getRunnerCurrent(db);
    if (c?.jobId === jobId && c.step === "Waiting for you to finish and submit" && lastPage) return lastPage;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("the run never started waiting for the user");
}
const outline = (page: Page, sel: string) => page.locator(sel).evaluate(inPage((e: HTMLElement) => e.style.outline));

/** A needs-you job whose relocation and phone questions only the user can answer. */
function needsYouJob(url = "https://mini-ats.test/apply"): { job: Job; spy: { submits: number; fills: string[] } } {
  saveProfile(db, { willingToRelocate: null, phone: null });
  const j = addJob(url);
  setStatus(db, j.id, "needs-you", "2 questions need you");
  addNeedsYou(db, { jobId: j.id, kind: "other", message: "Mini Co · Software Engineer Intern: questions need you" });
  const spy = { submits: 0, fills: [] as string[] };
  deps.handlers = [{
    ...miniAtsHandler,
    async fill(page, field, answer) { spy.fills.push(field.label); return miniAtsHandler.fill(page, field, answer); },
    async submit(page) { spy.submits++; return miniAtsHandler.submit(page); },
  }];
  return { job: getJob(db, j.id)!, spy };
}

test("hand-finish fills what it can, highlights the open questions without typing in them, and the user's submission is recorded and learned", async () => {
  const { job: j, spy } = needsYouJob();
  const hand = { ...deps, pollMs: 50, handFinishWaitMs: 20_000 };
  const running = runJob(hand, j.id, "hand-finish");
  const page = await untilWaitingForUser(j.id);

  // Answered fields are filled; the two open questions are outlined and left empty.
  expect(await page.locator("#first").inputValue()).toBe("Luis");
  expect(await outline(page, "#reloc")).toContain("solid");
  expect(await outline(page, "#phone")).toContain("solid");
  expect(await outline(page, "#first")).toBe("");
  expect(await page.locator("#reloc").inputValue()).toBe("");
  expect(await page.locator("#phone").inputValue()).toBe("");
  expect(spy.fills).not.toContain("Are you willing to relocate?");
  expect(spy.fills).not.toContain("Phone");
  expect(getJob(db, j.id)!.status).toBe("filling");

  // The user answers and clicks the site's own submit button.
  await page.locator("#reloc").selectOption({ label: "No" });
  await page.locator("#phone").fill("5559876543");
  await new Promise(r => setTimeout(r, 150));
  await page.locator("#submit").click();

  expect(await running).toBe("submitted");
  expect(spy.submits).toBe(0);
  expect(miniAts.submissions).toEqual([expect.objectContaining({ first: "Luis", reloc: "n", phone: "5559876543", certify: "on" })]);
  expect(getJob(db, j.id)).toMatchObject({ status: "submitted" });
  expect(listOpenNeedsYou(db)).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM needs_you WHERE job_id = ? AND resolved = 0").get(j.id)).toEqual({ n: 0 });
  const answers = Object.fromEntries(listQuestions(db).map(q => [q.canonical, q]));
  expect(answers["Are you willing to relocate?"]).toMatchObject({ status: "approved", answer: "No" });
  expect(Object.values(answers).find(q => /phone/i.test(q.canonical))).toMatchObject({ status: "approved", answer: "5559876543" });
  const record = JSON.parse(readFileSync(path.join(listRecords(j.id)[0]!, "record.json"), "utf8"));
  expect(record.answers).toEqual(expect.arrayContaining([{ label: "Phone", value: "5559876543", source: "you" }]));
  expect(opened).toEqual([{ headless: false }]);
  expect(lastPage!.isClosed()).toBe(true);
  expect(getRunnerCurrent(db)).toBeNull();
});

test("hand-finish answers free other jobs blocked on the same questions", async () => {
  const { job: j } = needsYouJob();
  const other = addJob("https://mini-ats.test/apply?other=2");
  const hand = { ...deps, pollMs: 50, handFinishWaitMs: 20_000 };
  // Block the other job on the same questions by running it once.
  expect(await runJob(deps, other.id)).toBe("needs-you");
  const running = runJob(hand, j.id, "hand-finish");
  const page = await untilWaitingForUser(j.id);
  await page.locator("#reloc").selectOption({ label: "Yes" });
  await page.locator("#phone").fill("5559876543");
  await new Promise(r => setTimeout(r, 150));
  await page.locator("#submit").click();
  expect(await running).toBe("submitted");
  expect(getJob(db, other.id)!.status).toBe("queued");
});

test("closing the window before submitting leaves the job waiting on the user, learning nothing", async () => {
  const { job: j, spy } = needsYouJob();
  const running = runJob({ ...deps, pollMs: 50, handFinishWaitMs: 20_000 }, j.id, "hand-finish");
  const page = await untilWaitingForUser(j.id);
  await page.locator("#phone").fill("5550000000");
  await new Promise(r => setTimeout(r, 150));
  await page.close();
  expect(await running).toBe("needs-you");
  expect(getJob(db, j.id)!.statusReason).toBe("Closed before submitting");
  expect(spy.submits).toBe(0);
  expect(fixtureSubmitCount()).toBe(0);
  expect(listQuestions(db).filter(q => q.status === "approved")).toEqual([]);
  // The open questions still show in the inbox, and the job can be finished by hand again.
  expect(blockersForJob(db, j.id)).toHaveLength(2);
  expect(inboxItems(db).flatMap(i => i.jobs.map(x => x.id))).toContain(j.id);
  expect(canHandFinish(db, j.id)).toBe(true);
});

test("a window closed after the form may have been sent is flagged as possibly sent, never finishable again", async () => {
  const { job: j } = needsYouJob("https://mini-ats.test/apply?oops=1");
  const running = runJob({ ...deps, pollMs: 50, handFinishWaitMs: 20_000 }, j.id, "hand-finish");
  const page = await untilWaitingForUser(j.id);
  await page.locator("#reloc").selectOption({ label: "Yes" });
  await page.locator("#phone").fill("5559876543");
  await page.locator("#submit").click();
  await new Promise(r => setTimeout(r, 200));
  await page.close();
  expect(await running).toBe("needs-you");
  const after = getJob(db, j.id)!;
  expect(after.statusReason).toBe("Finished by hand? Not confirmed — check before retrying");
  expect(isUnknownSubmission(after)).toBe(true);
  expect(canHandFinish(db, j.id)).toBe(false);
  expect(listOpenNeedsYou(db).map(n => n.message).join()).toContain("Finished by hand? Not confirmed");
  expect(listQuestions(db).filter(q => q.status === "approved")).toEqual([]);
});

test("hand-finish times out into the same endings", async () => {
  const { job: j } = needsYouJob();
  expect(await runJob({ ...deps, pollMs: 50, handFinishWaitMs: 300 }, j.id, "hand-finish")).toBe("needs-you");
  expect(getJob(db, j.id)!.statusReason).toBe("Closed before submitting");
});

test("hand-finish only runs jobs waiting on the user's input, never a possibly sent one or one waiting for a CAPTCHA", async () => {
  setStatus(db, job.id, "queued");
  expect(await runJob(deps, job.id, "hand-finish")).toBe("queued");
  setStatus(db, job.id, "needs-you", "Submission state unknown — check before retrying");
  expect(await runJob(deps, job.id, "hand-finish")).toBe("needs-you");
  setStatus(db, job.id, "needs-you", "CAPTCHA");
  addNeedsYou(db, { jobId: job.id, kind: "captcha", message: "solve" });
  expect(await runJob(deps, job.id, "hand-finish")).toBe("needs-you");
  expect(opened).toEqual([]);
  expect(getJob(db, job.id)!.attempts).toBe(0);
});
