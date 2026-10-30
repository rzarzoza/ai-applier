import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import type { AtsHandler } from "../src/ats/types.js";
import { openDb } from "../src/db/db.js";
import { migrations } from "../src/db/migrations.js";
import { getExtToken } from "../src/ext/api.js";
import type { ResolveResponse } from "../src/ext/protocol.js";
import { getJob, setStatus, upsertPosting } from "../src/jobs/repo.js";
import type { Provider } from "../src/llm/llm.js";
import { startApp } from "../src/main.js";
import { getProfile, saveProfile } from "../src/profile/profile.js";
import { getSettings, saveSettings } from "../src/settings.js";
import { startFakeOllama } from "./helpers/fake-ollama.js";
import { until } from "./helpers/live-setup.js";
import { miniAtsHandler } from "./helpers/mini-ats-handler.js";
import { textPdf } from "./helpers/text-pdf.js";

const secrets = { get: async () => null, set: async () => {} };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const addQueued = (db: ReturnType<typeof openDb>, url: string) => {
  const { job } = upsertPosting(db, { sourceId: "s", listingId: url, company: "Mini Co", title: "Software Engineer Intern", locations: ["Austin, TX"],
    category: "Software", terms: ["Summer 2027"], degrees: [], sponsorship: null, url, datePosted: new Date(), active: true });
  setStatus(db, job.id, "queued");
  return job;
};

test("default settings: everything runs locally, Claude is off, and the background applier is off", () => {
  const s = getSettings(openDb(":memory:"));
  expect(s).toMatchObject({
    aiFast: "local", aiWrite: "local", aiLocalOff: "leave", aiDailyBudgetUsd: 1, backgroundApplier: false,
    ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "qwen2.5:14b",
  });
});

test("an existing install's settings are migrated to the background applier off, keeping the rest (paused included)", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "ai-applier-mig-")), "app.db");
  const old = new DatabaseSync(file);
  // The database as it was before the AI-cost migration, with the settings an existing install has.
  for (let i = 0; i < migrations.length - 1; i++) old.exec(migrations[i]!);
  old.exec(`PRAGMA user_version = ${migrations.length - 1}`);
  old.prepare("INSERT INTO kv (key, value) VALUES ('settings', ?)").run(JSON.stringify({ paused: false, pollMinutes: 15, backgroundApplier: true }));
  old.close();
  const db = openDb(file);
  expect(getSettings(db)).toMatchObject({ backgroundApplier: false, paused: false, pollMinutes: 15, aiFast: "local" });
  db.close();
});

test("with the background applier off (the default) the scheduler takes no queued job", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-ai-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  saveSettings(seed, { paused: false });
  const job = addQueued(seed, "https://never.test/apply");
  seed.close();
  const open = vi.fn(async () => ({ ok: false as const, reason: "closed" as const }));
  const handler: AtsHandler = { ...miniAtsHandler, name: "never", matches: u => u.includes("never.test"), open };
  const app = await startApp({ dataDir, port: 0, startLoops: true, pollSources: false, secrets, handlers: [handler] });
  cleanups.push(() => app.stop());
  await new Promise(r => setTimeout(r, 1500));
  expect(open).not.toHaveBeenCalled();
  const html = await (await fetch(`${app.url}/`)).text();
  expect(html).toContain("Background applier is off");
  const db = openDb(path.join(dataDir, "app.db"));
  expect(getJob(db, job.id)!.status).toBe("queued");
  db.close();
});

test("with default AI settings no Claude call happens anywhere: extension, resume import, and a runner job", async () => {
  const ollama = await startFakeOllama();
  cleanups.push(ollama.close);
  const dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-ai-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  // Only where the local model lives differs from the defaults (a fake on 127.0.0.1, never the real model).
  saveSettings(seed, { paused: false, backgroundApplier: true, ollamaUrl: ollama.url });
  saveProfile(seed, { firstName: "Luis", lastName: "Hernandez", email: "luis@example.com" });
  const token = getExtToken(seed);
  const job = addQueued(seed, "https://mini-ats.test/apply");
  seed.close();

  const claude = vi.fn((): Provider => { throw new Error("Claude must not be called with default settings"); });
  const keychain = { get: vi.fn(async () => "sk-test"), set: vi.fn(async () => {}) };
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const app = await startApp({
    dataDir, port: 0, startLoops: true, pollSources: false, secrets: keychain, claude, handlers: [miniAtsHandler],
    launchBrowser: async () => { const ctx = await browser.newContext(); await ctx.route("**/*", r => r.abort()); return ctx; },
  });
  cleanups.push(() => app.stop());

  // The runner (background applier on) fills the queued job.
  const db = openDb(path.join(dataDir, "app.db"));
  cleanups.push(async () => db.close());
  await until(() => !["queued", "filling"].includes(getJob(db, job.id)!.status), 30_000);

  // The extension resolves a form.
  const res = await fetch(`${app.url}/ext/resolve`, {
    method: "POST",
    headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "x-ai-applier-token": token, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://boards.greenhouse.io/acme/jobs/1", title: "SWE Intern", fields: [
      { id: "f", label: "First Name", kind: "text", required: true },
      { id: "w", label: "Why do you want to work at Acme?", kind: "textarea", required: true },
    ] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json() as ResolveResponse).resolutions).toHaveLength(2);

  // A resume is imported (its text read on this Mac, then sent to the local model).
  const fd = new FormData();
  fd.set("resume", new File([new Uint8Array(textPdf(["Luis Hernandez", "luis@example.com", "Rice University, B.S. Computer Science"]))], "r.pdf", { type: "application/pdf" }));
  const up = await fetch(`${app.url}/profile/resume`, { method: "POST", body: fd, headers: { origin: app.url } });
  expect(await up.text()).not.toContain("Couldn't read the resume");
  expect(getProfile(db).resumeText).toContain("Rice University");
  const resumeReq = ollama.requests.find(r => r.messages[1]!.content.includes("<resume>"));
  expect(resumeReq?.messages[1]!.content).toContain("Rice University");

  expect(ollama.requests.length).toBeGreaterThan(2);
  expect(claude).not.toHaveBeenCalled();
  // No Anthropic key is even read from the Keychain.
  expect(keychain.get).not.toHaveBeenCalledWith("anthropic-api-key");
  const rows = db.prepare("SELECT DISTINCT provider FROM llm_usage").all() as { provider: string }[];
  expect(rows.map(r => r.provider)).toEqual(["ollama"]);
});
