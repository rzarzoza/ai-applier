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
import { clearRunnerCurrent } from "./runner/current.js";
import { flagInterruptedRuns, runJob, runNext, type RunMode, type RunnerDeps } from "./runner/runner.js";
import { pollAll, type PollReport } from "./sources/poller.js";
import { readmeTableAdapter } from "./sources/readme-table.js";
import { simplifyAdapter } from "./sources/simplify.js";
import { syncTracker, type SyncResult } from "./tracker/sync.js";
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
  // Nothing is running yet, so a job still "filling" was cut off by the last shutdown.
  const interrupted = flagInterruptedRuns(db);
  if (interrupted.length) log(`${interrupted.length} interrupted ${interrupted.length === 1 ? "run needs" : "runs need"} checking (see the Inbox)`);
  // Nothing is running yet: whatever the dashboard's "Applying now" card last showed is over.
  clearRunnerCurrent(db);
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

  // Tracker syncs never touch the browser, so they skip the serial queue; two never overlap.
  let syncing: Promise<SyncResult> | null = null;
  let syncAgain = false;
  const runSync = (): Promise<SyncResult> => {
    if (syncing) { syncAgain = true; return syncing; }
    const p: Promise<SyncResult> = (async () => {
      let result = await syncTracker(db, { secrets, now: () => new Date() });
      while (syncAgain) { syncAgain = false; result = await syncTracker(db, { secrets, now: () => new Date() }); }
      if (result.error) log(`Tracker sync: ${result.error}`);
      return result;
    })().catch((e): SyncResult => ({ csv: true, sheet: "error", error: errText(e) }))
      .finally(() => { syncing = null; });
    syncing = p;
    return p;
  };

  const queue = new SerialQueue();
  const runnerDeps = (): RunnerDeps => ({
    db, llm, browser: persistentChromium, notify: macNotify, now: () => new Date(), handlers: HANDLERS,
    onSubmitted: () => { void runSync(); },
    hasApiKey: async () => {
      if (process.env.ANTHROPIC_API_KEY) return true;
      // A Keychain that can't be read is not proof the key is missing; a run will halt if it is.
      try { return !!(await secrets.get(API_KEY_NAME)); } catch { return true; }
    },
  });
  /** Every job run goes through the one queue: the persistent Chromium profile can only be opened once. */
  const runQueued = (task: () => ReturnType<typeof runNext>, what: string) =>
    queue.run(async () => {
      const status = await task();
      if (status) log(`${what}: job finished as ${status}`);
      return status;
    });
  /** Jobs the user asked to run that are waiting in the queue (or running); a second click doesn't queue them twice. */
  const requested = new Set<string>();
  const runById = (jobId: string, mode: Exclude<RunMode, "auto">) => {
    if (requested.has(jobId)) return;
    requested.add(jobId);
    queue.run(async () => {
      const status = await runJob(runnerDeps(), jobId, mode);
      log(`${mode} ${getJob(db, jobId)?.company ?? jobId}: job finished as ${status}`);
    }).catch(e => log(`Run of job ${jobId} failed: ${errText(e)}`))
      .finally(() => requested.delete(jobId));
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

  let port = 0;
  const app = createApp({
    db, llm, secrets, pollNow, syncTracker: runSync, localPort: () => port,
    runInteractive: id => runById(id, "interactive"),
    runReviewed: id => runById(id, "submit-reviewed"),
    runHandFinish: id => runById(id, "hand-finish"),
    requestedRuns: () => [...requested],
    onApiKeySaved: () => { void refreshLlm(); },
  });

  const server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: "127.0.0.1" }, () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

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
        Promise.all([...loops, queue.idle(), pollInFlight(), syncing ?? Promise.resolve()]).then(() => true),
        new Promise<false>(r => setTimeout(() => r(false), STOP_WAIT_MS).unref()),
      ]);
      if (settled) db.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const envPort = Number(process.env.AI_APPLIER_PORT);
  const app = await startApp({ startLoops: true, port: Number.isInteger(envPort) && envPort > 0 ? envPort : undefined });
  log(`AI Applier running at ${app.url}`);
  process.once("SIGINT", () => { void app.stop().finally(() => process.exit(0)); });
}
