import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { expect, test } from "vitest";
import { listOpenNeedsYou } from "../src/answers/bank.js";
import { openDb } from "../src/db/db.js";
import { getJob, setStatus, upsertPosting } from "../src/jobs/repo.js";
import { startApp } from "../src/main.js";

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
