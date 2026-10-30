import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { expect, test } from "vitest";
import { listOpenNeedsYou } from "../src/answers/bank.js";
import { openDb } from "../src/db/db.js";
import { getJob, setStatus, upsertPosting } from "../src/jobs/repo.js";
import { startApp } from "../src/main.js";
import { getRunnerCurrent, setRunnerCurrent } from "../src/runner/current.js";
import { chromium } from "playwright";
import type { AtsHandler } from "../src/ats/types.js";
import { saveProfile } from "../src/profile/profile.js";
import { saveSettings } from "../src/settings.js";
import { fakeLlm, until } from "./helpers/live-setup.js";
import { miniAtsHandler } from "./helpers/mini-ats-handler.js";

const secrets = { get: async () => null, set: async () => {} };

test("startApp serves the inbox on a free local port and stops cleanly", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const app = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(app.url).not.toMatch(/:0$/);
  const res = await fetch(`${app.url}/inbox`);
  expect(res.status).toBe(200);
  await app.stop();
  await expect(fetch(`${app.url}/inbox`)).rejects.toThrow();
});

test("a fresh database starts paused; a stored paused:false is kept", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const first = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  expect(await (await fetch(`${first.url}/settings`)).text()).toMatch(/name="paused"[^>]*checked/);
  const saved = await fetch(`${first.url}/settings`, { method: "POST", headers: { origin: first.url }, body: new URLSearchParams({ reviewMode: "off", pollMinutes: "30" }), redirect: "manual" });
  expect(saved.status).toBe(303);
  await first.stop();
  const second = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  expect(await (await fetch(`${second.url}/settings`)).text()).not.toMatch(/name="paused"[^>]*checked/);
  await second.stop();
});

test("a job left filling by an interrupted run is flagged state unknown at startup", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  const { job } = upsertPosting(seed, { sourceId: "s", listingId: "1", company: "Acme", title: "Intern", locations: ["NYC"], category: null,
    terms: [], degrees: [], sponsorship: null, url: "https://acme.test/1", datePosted: new Date(), active: true });
  setStatus(seed, job.id, "filling");
  seed.close();
  const app = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  const html = await (await fetch(`${app.url}/inbox`)).text();
  await app.stop();
  const db = openDb(path.join(dataDir, "app.db"));
  expect(getJob(db, job.id)).toMatchObject({ status: "needs-you", statusReason: "Submission state unknown — check before retrying" });
  expect(listOpenNeedsYou(db).map(n => n.kind)).toEqual(["other"]);
  expect(html).toContain("the app stopped during this application");
  expect(html).not.toContain("Do it now");
  db.close();
});

test("a job cut off before submitting is queued again at startup, not flagged", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  const { job } = upsertPosting(seed, { sourceId: "s", listingId: "1", company: "Acme", title: "Intern", locations: ["NYC"], category: null,
    terms: [], degrees: [], sponsorship: null, url: "https://acme.test/1", datePosted: new Date(), active: true });
  setStatus(seed, job.id, "filling");
  setRunnerCurrent(seed, { jobId: job.id, step: "Filling fields", startedAt: new Date().toISOString(), mode: "auto" });
  seed.close();
  const app = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  await app.stop();
  const db = openDb(path.join(dataDir, "app.db"));
  expect(getJob(db, job.id)!.status).toBe("queued");
  expect(listOpenNeedsYou(db)).toEqual([]);
  expect(getRunnerCurrent(db)).toBeNull();
  db.close();
});

test("the running dashboard refuses other hosts and cross-site changes", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const app = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  const port = Number(new URL(app.url).port);
  // A DNS-rebinding page reaches 127.0.0.1 but names its own host.
  const status = await new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/inbox", headers: { host: `evil.test:${port}` } }, res => { res.resume(); resolve(res.statusCode!); })
      .on("error", reject).end();
  });
  expect(status).toBe(403);
  const crossSite = await fetch(`${app.url}/settings`, { method: "POST", headers: { origin: "http://evil.test" }, body: new URLSearchParams({ reviewMode: "all", pollMinutes: "1" }) });
  expect(crossSite.status).toBe(403);
  await app.stop();
});

test("a stale Applying now pointer from the last session is cleared at startup", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  setRunnerCurrent(seed, { jobId: "old", step: "Submitting", startedAt: new Date().toISOString() });
  seed.close();
  const app = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  const html = await (await fetch(`${app.url}/`)).text();
  await app.stop();
  expect(html).toContain("Applying now");
  expect(html).not.toContain("Submitting");
  const db = openDb(path.join(dataDir, "app.db"));
  expect(getRunnerCurrent(db)).toBeNull();
  db.close();
});

test("a rebuild from the dashboard runs right away while an auto run is still in progress", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-main-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  saveSettings(seed, { paused: false, backgroundApplier: true });
  saveProfile(seed, { firstName: "Luis", lastName: "Hernandez", email: "luis@example.com" });
  const add = (n: string, url: string) => upsertPosting(seed, { sourceId: "s", listingId: n, company: `Co ${n}`, title: "Software Engineer Intern",
    locations: ["Austin, TX"], category: "Software", terms: ["Summer 2027"], degrees: [], sponsorship: null, url, datePosted: new Date(), active: true }).job;
  const slowJob = add("1", "https://slow-ats.test/apply");
  setStatus(seed, slowJob.id, "queued");
  const waiting = add("2", "https://mini-ats.test/apply");
  setStatus(seed, waiting.id, "needs-you", "2 questions need you");
  seed.close();

  // A slow auto run: its form takes until the end of the test to open.
  let started = false;
  let finish!: () => void;
  const gate = new Promise<void>(r => { finish = r; });
  const slow: AtsHandler = { ...miniAtsHandler, name: "slow-ats", matches: u => u.includes("slow-ats.test"),
    async open() { started = true; await gate; return { ok: false, reason: "closed", detail: "test" }; } };
  const browser = await chromium.launch();
  const app = await startApp({
    dataDir, port: 0, startLoops: true, pollSources: false, secrets: { get: async () => "key", set: async () => {} }, llm: fakeLlm(), handlers: [slow, miniAtsHandler],
    launchBrowser: async () => { const ctx = await browser.newContext(); await ctx.route("**/*", r => r.abort()); return ctx; },
  });
  try {
    await until(() => started);
    const post = await fetch(`${app.url}/live/${waiting.id}/rebuild`, { method: "POST", headers: { origin: app.url } });
    expect(await post.text()).toContain("Rebuilding your application…");
    await until(async () => (await (await fetch(`${app.url}/live/${waiting.id}/status`)).json() as { kind: string }).kind === "parked", 20_000);
    const panel = await (await fetch(`${app.url}/live/${waiting.id}/panel`)).text();
    expect(panel).toContain(`data-live="${waiting.id}"`);
    // The auto run is still going.
    const db = openDb(path.join(dataDir, "app.db"));
    expect(getJob(db, slowJob.id)!.status).toBe("filling");
    db.close();
  } finally {
    finish();
    await app.stop();
    await browser.close();
  }
});
