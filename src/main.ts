import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { HANDLERS } from "./ats/registry.js";
import { openDb } from "./db/db.js";
import { getJob } from "./jobs/repo.js";
import { ClaudeLlm, type Llm } from "./llm/llm.js";
import { paths, setDataDir } from "./paths.js";
import { SerialQueue } from "./scheduler.js";
import { getSecret, setSecret } from "./secrets.js";
import { getJson, getSettings, saveSettings, setJson } from "./settings.js";
import { persistentChromium } from "./runner/browser.js";
import { macNotify } from "./runner/notify.js";
import { runJob, runNext, type RunnerDeps } from "./runner/runner.js";
import { pollAll, type PollReport } from "./sources/poller.js";
import { readmeTableAdapter } from "./sources/readme-table.js";
import { simplifyAdapter } from "./sources/simplify.js";
import { createApp } from "./web/server.js";

const DEFAULT_PORT = 4310;
const IDLE_SLEEP_MS = 30_000;
const STOP_WAIT_MS = 5_000;
const API_KEY_NAME = "anthropic-api-key";

type Secrets = { get(name: string): Promise<string | null>; set(name: string, value: string): Promise<void> };

export interface StartOptions {
  dataDir?: string;
  port?: number;
  startLoops?: boolean;
  /** Keychain access; defaults to the real macOS Keychain. Tests inject fakes. */
  secrets?: Secrets;
}

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

export async function startApp(opts: StartOptions = {}): Promise<{ url: string; stop(): Promise<void> }> {
  if (opts.dataDir) setDataDir(opts.dataDir);
  mkdirSync(paths.dataDir, { recursive: true });
  const db = openDb(paths.db);
  // A fresh database starts paused so nothing applies before the profile, resume and filters are set up.
  if (!db.prepare("SELECT 1 FROM kv WHERE key = 'settings'").get()) saveSettings(db, { paused: true });
  const secrets: Secrets = opts.secrets ?? { get: getSecret, set: setSecret };

  // The app talks to the LLM through this wrapper, so a key saved in Settings takes effect without a restart.
  let current: Llm = new ClaudeLlm();
  const refreshLlm = async () => {
    let apiKey: string | undefined;
    try { apiKey = (await secrets.get(API_KEY_NAME)) ?? undefined; } catch (e) { log(`Could not read the API key from the Keychain: ${errText(e)}`); }
    current = new ClaudeLlm({ apiKey });
  };
  await refreshLlm();
  const llm: Llm = { structured: req => current.structured(req) };

  const queue = new SerialQueue();
  const runnerDeps = (): RunnerDeps => ({
    db, llm, browser: persistentChromium, notify: macNotify, now: () => new Date(), handlers: HANDLERS,
  });
  /** Every job run goes through the one queue: the persistent Chromium profile can only be opened once. */
  const runQueued = (task: () => ReturnType<typeof runNext>, what: string) =>
    queue.run(async () => {
      const status = await task();
      if (status) log(`${what}: job finished as ${status}`);
      return status;
    });
  const runById = (jobId: string, mode: "interactive" | "submit-reviewed") => {
    queue.run(async () => {
      const status = await runJob(runnerDeps(), jobId, mode);
      log(`${mode} ${getJob(db, jobId)?.company ?? jobId}: job finished as ${status}`);
    }).catch(e => log(`Run of job ${jobId} failed: ${errText(e)}`));
  };

  let polling: Promise<void> | null = null;
  const pollNow = () => {
    polling ??= (async () => {
      try {
        const reports = await pollAll(db, { adapters: { "simplify-json": simplifyAdapter, "readme-table": readmeTableAdapter }, now: new Date() });
        const at = new Date().toISOString();
        const stored = getJson<Record<string, { at: string; report: PollReport }>>(db, "pollReports", {});
        for (const report of reports) {
          stored[report.sourceId] = { at, report };
          log(report.error ? `Poll ${report.sourceId} failed: ${report.error}`
            : `Poll ${report.sourceId}: ${report.fetched} fetched, ${report.newJobs} new, ${report.queued} queued, ${report.skipped} skipped, ${report.closed} closed`);
        }
        setJson(db, "pollReports", stored);
      } catch (e) {
        log(`Poll failed: ${errText(e)}`);
      } finally {
        polling = null;
      }
    })();
  };
  const pollInFlight = () => polling ?? Promise.resolve();

  const app = createApp({
    db, llm, secrets, pollNow,
    runInteractive: id => runById(id, "interactive"),
    runReviewed: id => runById(id, "submit-reviewed"),
    onApiKeySaved: () => { void refreshLlm(); },
  });

  const server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let stopped = false;
  const wakers = new Set<() => void>();
  const sleep = (ms: number) => new Promise<void>(resolve => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wakers.delete(done); resolve(); }
    wakers.add(done);
  });

  const loops: Promise<void>[] = [];
  if (opts.startLoops) {
    loops.push((async () => {
      while (!stopped) {
        pollNow();
        await pollInFlight();
        await sleep(getSettings(db).pollMinutes * 60_000);
      }
    })());
    loops.push((async () => {
      while (!stopped) {
        let ran = false;
        try { ran = (await runQueued(() => runNext(runnerDeps()), "auto")) !== null; } catch (e) { log(`Runner error: ${errText(e)}`); }
        if (!ran && !stopped) await sleep(IDLE_SLEEP_MS);
      }
    })());
  }

  return {
    url,
    async stop() {
      stopped = true;
      for (const wake of [...wakers]) wake();
      await new Promise<void>(resolve => { server.close(() => resolve()); (server as { closeAllConnections?(): void }).closeAllConnections?.(); });
      // A job may be mid-run (even waiting on the user); give it a moment, then leave it.
      const settled = await Promise.race([
        Promise.all([...loops, queue.idle(), pollInFlight()]).then(() => true),
        new Promise<false>(r => setTimeout(() => r(false), STOP_WAIT_MS).unref()),
      ]);
      if (settled) db.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApp({ startLoops: true });
  log(`AI Applier running at ${app.url}`);
  process.once("SIGINT", () => { void app.stop().finally(() => process.exit(0)); });
}
