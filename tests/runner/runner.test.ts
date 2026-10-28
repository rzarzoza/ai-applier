import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { openDb, type Db } from "../../src/db/db.js";
import { addBlocker, addNeedsYou, blockersForJob, createQuestion, listOpenNeedsYou, listQuestions, setOverride } from "../../src/answers/bank.js";
import { paths } from "../../src/paths.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { Job } from "../../src/jobs/types.js";
import { saveProfile, type Profile } from "../../src/profile/profile.js";
import { saveSettings } from "../../src/settings.js";
import type { Posting } from "../../src/sources/types.js";
import { persistentChromium, type BrowserProvider } from "../../src/runner/browser.js";
import { notificationScript } from "../../src/runner/notify.js";
import { listRecords } from "../../src/runner/records.js";
import { runJob, runNext, type RunnerDeps } from "../../src/runner/runner.js";
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
    .on("draft", () => ({ answerable: false, draft: null }));
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

test("unknown required question → needs-you with blocker, nothing filled or submitted", async () => {
  saveProfile(db, { willingToRelocate: null });
  expect(await runJob(deps, job.id)).toBe("needs-you");
  expect(blockersForJob(db, job.id)).toHaveLength(1);
  expect(fixtureSubmitCount()).toBe(0);
  expect(getJob(db, job.id)!.statusReason).toBe("1 question needs you");
  const [q] = listQuestions(db).filter(x => x.id === blockersForJob(db, job.id)[0]!.questionId);
  expect(q!.canonical).toBe("Are you willing to relocate?");
  expectScreenshot(job.id);
  // Nothing was typed into the page before stopping.
  expect(JSON.parse(snapshotRow(job.id)!.resolutions_json).filter((r: { status: string }) => r.status === "blocked")).toHaveLength(1);
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

test("validation error after submit → failed with page messages", async () => {
  saveProfile(db, { phone: "555-ABC" });
  expect(await runJob(deps, job.id)).toBe("failed");
  expect(getJob(db, job.id)!.statusReason).toContain("Invalid phone");
  expect(fixtureSubmitCount()).toBe(0);
  expectScreenshot(job.id);
});

test("an unknown outcome fails with its detail; no confirmation in time fails too", async () => {
  const oops = addJob("https://mini-ats.test/apply?oops=1");
  expect(await runJob(deps, oops.id)).toBe("failed");
  expect(getJob(db, oops.id)!.statusReason).toContain("Something went wrong on our side");
  expectScreenshot(oops.id);

  const silent = addJob("https://mini-ats.test/apply?silent=1");
  expect(await runJob({ ...deps, submitWaitMs: 300 }, silent.id)).toBe("failed");
  expect(getJob(db, silent.id)!.statusReason).toMatch(/no confirmation/i);
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
