import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { Browser, Page } from "playwright";
import { blockersForJob, getOverrides, listOpenNeedsYou, listQuestions } from "../../src/answers/bank.js";
import { getJob, PAUSED_MID_RUN, setStatus } from "../../src/jobs/repo.js";
import { resumeRunner } from "../../src/runner/pause.js";
import { getSettings, saveSettings } from "../../src/settings.js";
import type { AtsHandler } from "../../src/ats/types.js";
import { listRecords } from "../../src/runner/records.js";
import { JOB_BUSY, runJob } from "../../src/runner/runner.js";
import { LiveService } from "../../src/runner/live.js";
import { JobLocks } from "../../src/scheduler.js";
import { canOpenLive } from "../../src/jobs/repo.js";
import { center, launchBrowser, liveSetup, until } from "../helpers/live-setup.js";
import { fixtureSubmitCount, miniAts, miniAtsHandler } from "../helpers/mini-ats-handler.js";

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

let s: ReturnType<typeof liveSetup>;
beforeEach(() => { s = liveSetup(browser); });
afterEach(async () => { await s.close(); });

const parkedPage = (jobId: string): Page => s.manager.get(jobId)!.page;
const keepEligible = (id: string) => { const j = getJob(s.db, id); return !!j && canOpenLive(j); };

test("a run that ends waiting on the user parks its filled page instead of closing it", async () => {
  const j = await s.needsYouJob();
  expect(j.status).toBe("needs-you");
  expect(s.manager.isParked(j.id)).toBe(true);
  const page = parkedPage(j.id);
  expect(page.isClosed()).toBe(false);
  expect(await page.locator("#first").inputValue()).toBe("Luis");
  expect(await page.locator("#phone").inputValue()).toBe("");
  // Every field but files is watched; the blocked ones carry their bank question.
  const watch = s.manager.get(j.id)!.watch;
  expect(watch.find(w => w.field.label === "Phone")).toMatchObject({ filled: null, questionId: expect.any(Number) });
  expect(watch.find(w => w.field.label === "First Name")).toMatchObject({ filled: { type: "text", text: "Luis" } });
  expect(fixtureSubmitCount()).toBe(0);
});

test("a run that stops for review parks its page; a submitted run closes it", async () => {
  saveSettings(s.db, { reviewMode: "all" });
  const review = s.addJob();
  expect(await runJob(s.deps, review.id)).toBe("ready-to-review");
  expect(s.manager.isParked(review.id)).toBe(true);
  saveSettings(s.db, { reviewMode: "off" });
  const done = s.addJob("https://mini-ats.test/apply?n=2");
  expect(await runJob(s.deps, done.id)).toBe("submitted");
  expect(s.manager.isParked(done.id)).toBe(false);
  expect(s.pages.at(-1)!.isClosed()).toBe(true);
  // Submitting the reviewed job runs it on a fresh page: the parked one is closed first.
  const old = parkedPage(review.id);
  expect(await runJob(s.deps, review.id, "submit-reviewed")).toBe("submitted");
  expect(old.isClosed()).toBe(true);
  expect(s.manager.isParked(review.id)).toBe(false);
});

test("at most 10 pages stay parked: the 11th closes the least recently viewed", async () => {
  const fake: AtsHandler = { ...miniAtsHandler };
  const pages: Page[] = [];
  for (let i = 0; i < 11; i++) {
    const session = await s.manager.open();
    pages.push(session.page);
    expect(session.park!(`job-${i}`, { handler: fake, fields: [], resolutions: [], watch: [], notes: [] })).toBe(true);
    if (i === 9) s.manager.touch("job-0"); // job-0 was just viewed: job-1 is now the least recently viewed
    await new Promise(r => setTimeout(r, 2));
  }
  expect(s.manager.parkedIds()).toHaveLength(10);
  expect(s.manager.isParked("job-1")).toBe(false);
  expect(s.manager.isParked("job-0")).toBe(true);
  expect(s.manager.isParked("job-10")).toBe(true);
  await until(() => pages[1]!.isClosed());
  expect(pages.filter(p => p.isClosed())).toHaveLength(1);
});

test("a parked page is closed once its job leaves needs-you or review (skipped, submitted, requeued)", async () => {
  const j = await s.needsYouJob();
  const page = parkedPage(j.id);
  expect(await s.manager.sweep(keepEligible)).toEqual([]);
  setStatus(s.db, j.id, "skipped", "Skipped by you");
  expect(await s.manager.sweep(keepEligible)).toEqual([j.id]);
  expect(page.isClosed()).toBe(true);
  expect(s.manager.isParked(j.id)).toBe(false);
});

test("rebuild reopens, fills (the user's values first), highlights and parks without submitting or touching the job", async () => {
  const j = await s.needsYouJob();
  await s.manager.unpark(j.id);
  const before = getJob(s.db, j.id)!;
  let submits = 0;
  s.deps.handlers = [{ ...miniAtsHandler, async submit(page) { submits++; return miniAtsHandler.submit(page); } }];
  const started = Date.now();
  expect(await runJob(s.deps, j.id, "rebuild")).toBe("needs-you");
  expect(Date.now() - started).toBeLessThan(30_000);
  const page = parkedPage(j.id);
  expect(await page.locator("#first").inputValue()).toBe("Luis");
  expect(await page.locator("#phone").evaluate(e => (e as HTMLElement).style.outline)).toContain("solid");
  expect(submits).toBe(0);
  expect(fixtureSubmitCount()).toBe(0);
  expect(getJob(s.db, j.id)).toMatchObject({ status: "needs-you", statusReason: before.statusReason, attempts: before.attempts });
  expect(blockersForJob(s.db, j.id)).toHaveLength(2);
  // A rebuild only opens jobs the live view may show.
  setStatus(s.db, j.id, "queued");
  await s.manager.unpark(j.id);
  expect(await runJob(s.deps, j.id, "rebuild")).toBe("queued");
  expect(s.manager.isParked(j.id)).toBe(false);
});

test("a rebuild that cannot open the form throws and leaves the job as it was", async () => {
  const j = s.addJob("https://mini-ats.test/blocked");
  s.markNeedsYou(j);
  await expect(runJob(s.deps, j.id, "rebuild")).rejects.toThrow(/Blocked/);
  expect(getJob(s.db, j.id)!.status).toBe("needs-you");
  expect(s.manager.isParked(j.id)).toBe(false);
  s.live.rebuild(j.id);
  expect(s.live.rebuildState(j.id).rebuilding).toBe(true);
  await until(() => !s.live.rebuildState(j.id).rebuilding);
  expect(s.live.rebuildState(j.id).error).toMatch(/Blocked/);
});

test("what the user types into the live page is saved as the job's values, and a rebuild restores it", async () => {
  const j = await s.needsYouJob();
  const page = parkedPage(j.id);
  const phone = await center(page, "#phone");
  expect(await s.live.input(j.id, [{ t: "click", ...phone }])).toBe(true);
  for (const key of "5559876543") await s.live.input(j.id, [{ t: "keydown", key }, { t: "keyup", key }]);
  // A typo fixed with Backspace, and Tab to the next field.
  await s.live.input(j.id, [{ t: "keydown", key: "Backspace" }, { t: "keyup", key: "Backspace" }, { t: "text", text: "3" }]);
  expect(await page.locator("#phone").inputValue()).toBe("5559876543");
  await s.live.tick(j.id);
  expect(getOverrides(s.db, j.id)).toEqual({ Phone: { type: "text", text: "5559876543" } });
  // The app's own values are not saved as the user's.
  expect(getOverrides(s.db, j.id)).not.toHaveProperty("First Name");

  // Evicted or after a restart: the rebuild fills it again.
  await s.live.close(j.id);
  expect(page.isClosed()).toBe(true);
  s.live.rebuild(j.id);
  await until(() => s.manager.isParked(j.id) && !s.live.rebuildState(j.id).rebuilding);
  expect(await parkedPage(j.id).locator("#phone").inputValue()).toBe("5559876543");
  expect(fixtureSubmitCount()).toBe(0);
});

test("a submission the user makes in the live page is recorded, learned and its page closed", async () => {
  const j = await s.needsYouJob();
  const page = parkedPage(j.id);
  // A native drop-down shows its options inside the page, where the live view can click them.
  await s.live.input(j.id, [{ t: "click", ...(await center(page, "#reloc")) }]);
  await until(async () => (await page.locator("[data-aa-select] div").count()) > 0);
  await s.live.input(j.id, [{ t: "click", ...(await center(page, "[data-aa-select] div:text-is('No')")) }]);
  expect(await page.locator("#reloc").inputValue()).toBe("n");
  await s.live.input(j.id, [{ t: "click", ...(await center(page, "#phone")) }, { t: "text", text: "5559876543" }]);
  await s.live.tick(j.id);
  await s.live.input(j.id, [{ t: "click", ...(await center(page, "#submit")) }]);
  await until(() => miniAts.submissions.length === 1);
  await s.live.tick(j.id);

  expect(miniAts.submissions).toEqual([expect.objectContaining({ first: "Luis", reloc: "n", phone: "5559876543", certify: "on" })]);
  expect(getJob(s.db, j.id)!.status).toBe("submitted");
  expect(listOpenNeedsYou(s.db)).toEqual([]);
  expect(s.submitted).toContain(j.id);
  expect(page.isClosed()).toBe(true);
  expect(s.manager.isParked(j.id)).toBe(false);
  const answers = Object.fromEntries(listQuestions(s.db).map(q => [q.canonical, q]));
  expect(answers["Are you willing to relocate?"]).toMatchObject({ status: "approved", answer: "No" });
  expect(Object.values(answers).find(q => /phone/i.test(q.canonical))).toMatchObject({ status: "approved", answer: "5559876543" });
  const record = JSON.parse(readFileSync(path.join(listRecords(j.id)[0]!, "record.json"), "utf8"));
  expect(record.answers).toEqual(expect.arrayContaining([
    { label: "Phone", value: "5559876543", source: "you" },
    { label: "First Name", value: "Luis", source: "profile" },
  ]));
});

test("a viewed page is watched on its own: the confirmation is picked up without a manual check", async () => {
  const j = await s.needsYouJob();
  const page = parkedPage(j.id);
  const off = s.live.subscribe(j.id, () => {})!;
  await page.locator("#reloc").selectOption({ label: "Yes" });
  await page.locator("#phone").fill("5550001111");
  await page.locator("#submit").click();
  await until(() => getJob(s.db, j.id)!.status === "submitted");
  off();
  expect(page.isClosed()).toBe(true);
});

test("a hand-finish wait that ends without a submission parks the page for the live view", async () => {
  const j = await s.needsYouJob();
  await s.manager.unpark(j.id);
  expect(await runJob({ ...s.deps, handFinishWaitMs: 300 }, j.id, "hand-finish")).toBe("needs-you");
  expect(getJob(s.db, j.id)!.statusReason).toBe("Closed before submitting");
  expect(s.manager.isParked(j.id)).toBe(true);
  expect(await parkedPage(j.id).locator("#first").inputValue()).toBe("Luis");
});

test("a rebuild stuck on the page (an await that never resolves) is stopped after the time limit and reported, never left spinning", async () => {
  const j = s.addJob();
  s.markNeedsYou(j);
  // page.evaluate has no timeout of its own: a page that never answers would hold the run forever.
  const stuck: AtsHandler = { ...miniAtsHandler, async open(page) { await page.evaluate(() => new Promise(() => {})); return { ok: true }; } };
  const locks = new JobLocks();
  const deps = { ...s.deps, handlers: [stuck], locks };
  const live = new LiveService({ db: s.db, manager: s.manager, rebuildTimeoutMs: 400, runRebuild: (id, signal) => runJob(deps, id, "rebuild", { signal }).then(() => {}) });
  try {
    live.rebuild(j.id);
    expect(live.rebuildState(j.id)).toMatchObject({ rebuilding: true, startedAt: expect.any(Number) });
    await until(() => !live.rebuildState(j.id).rebuilding, 5_000);
    expect(live.rebuildState(j.id).error).toMatch(/took over 0 seconds and was stopped/);
    // The stuck run was stopped too: its tab closed, nothing parked, the job untouched and free for the next run.
    await until(() => !locks.isHeld(j.id), 5_000);
    expect(s.pages.at(-1)!.isClosed()).toBe(true);
    expect(s.manager.isParked(j.id)).toBe(false);
    expect(getJob(s.db, j.id)!.status).toBe("needs-you");
    // Retry works once the page answers again.
    deps.handlers = [miniAtsHandler];
    live.rebuild(j.id);
    await until(() => s.manager.isParked(j.id) && !live.rebuildState(j.id).rebuilding);
    expect(live.rebuildState(j.id).error).toBeNull();
  } finally {
    await live.stop();
  }
});

test("never two runs on one job: a rebuild of a job another run holds fails at once; other runs wait for a rebuild", async () => {
  const j = s.addJob();
  s.markNeedsYou(j);
  const locks = new JobLocks();
  const deps = { ...s.deps, locks };
  const release = locks.tryAcquire(j.id)!;
  await expect(runJob(deps, j.id, "rebuild")).rejects.toThrow(JOB_BUSY);
  release();
  let gate!: () => void;
  const slow: AtsHandler = { ...miniAtsHandler, async open(page, url) { await new Promise<void>(r => { gate = r; }); return miniAtsHandler.open(page, url); } };
  const rebuilding = runJob({ ...deps, handlers: [slow] }, j.id, "rebuild");
  await until(() => !!gate);
  let handDone = false;
  const hand = runJob({ ...deps, handFinishWaitMs: 200 }, j.id, "hand-finish").then(st => { handDone = true; return st; });
  await new Promise(r => setTimeout(r, 200));
  expect(handDone).toBe(false);
  expect(s.pages).toHaveLength(1); // the hand-finish has not opened anything yet
  gate();
  await rebuilding;
  expect(await hand).toBe("needs-you");
  expect(locks.isHeld(j.id)).toBe(false);
});

test("pausing mid-run stops the auto run after the field being filled, parks its tab as filled so far, and resuming queues it again", async () => {
  const j = s.addJob();
  const filled: string[] = [];
  s.deps.handlers = [{ ...miniAtsHandler, async fill(page, field, answer) {
    await miniAtsHandler.fill(page, field, answer);
    filled.push(field.label);
    if (filled.length === 1) saveSettings(s.db, { paused: true }); // the user presses Pause while the first field is typed
  } }];
  expect(await runJob(s.deps, j.id)).toBe("needs-you");
  expect(filled).toHaveLength(1); // the field being typed finished; no other was started
  expect(getJob(s.db, j.id)).toMatchObject({ status: "needs-you", statusReason: PAUSED_MID_RUN, attempts: 0 });
  expect(listOpenNeedsYou(s.db).map(n => n.message)).toEqual([expect.stringContaining(PAUSED_MID_RUN)]);
  expect(s.manager.isParked(j.id)).toBe(true);
  expect(await parkedPage(j.id).locator("#first").inputValue()).toBe("Luis");
  expect(fixtureSubmitCount()).toBe(0);

  expect(resumeRunner(s.db)).toEqual([j.id]);
  expect(getSettings(s.db).paused).toBe(false);
  expect(getJob(s.db, j.id)!.status).toBe("queued");
  expect(listOpenNeedsYou(s.db)).toEqual([]);
  expect(await s.manager.sweep(keepEligible)).toEqual([j.id]);
  // Run again, it goes all the way.
  s.deps.handlers = [miniAtsHandler];
  expect(await runJob(s.deps, j.id)).toBe("submitted");
});

test("a pause after the last field stops the run before it submits; runs the user asked for are not paused", async () => {
  const j = s.addJob();
  s.deps.handlers = [{ ...miniAtsHandler, async readBack(page, field) {
    saveSettings(s.db, { paused: true }); // pressed while the answers are being checked
    return miniAtsHandler.readBack(page, field);
  } }];
  expect(await runJob(s.deps, j.id)).toBe("needs-you");
  expect(getJob(s.db, j.id)!.statusReason).toBe(PAUSED_MID_RUN);
  expect(fixtureSubmitCount()).toBe(0);
  // A rebuild (the user is waiting on it) still runs while paused.
  await s.manager.unpark(j.id);
  expect(await runJob(s.deps, j.id, "rebuild")).toBe("needs-you");
  expect(s.manager.isParked(j.id)).toBe(true);
});
