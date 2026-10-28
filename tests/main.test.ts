import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
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
  await fetch(`${first.url}/settings`, { method: "POST", body: new URLSearchParams({ reviewMode: "off", pollMinutes: "30" }) });
  await first.stop();
  const second = await startApp({ dataDir, port: 0, startLoops: false, secrets });
  expect(await (await fetch(`${second.url}/settings`)).text()).not.toMatch(/name="paused"[^>]*checked/);
  await second.stop();
});
