/**
 * The extension's service worker: it holds the pairing token, talks to the local app for the content scripts (pages
 * can't reach 127.0.0.1 themselves), and sends finished applications to the app, retrying from storage.
 */
import { DEFAULT_API_BASE, TOKEN_HEADER } from "../../src/ext/protocol.js";
import type { ApiResult, BgRequest, Config, PendingSubmit, ResumeFile } from "./messages.js";

const PENDING = "pending";
const MAX_TRIES = 30;

async function config(): Promise<Config> {
  const got = await chrome.storage.local.get(["token", "apiBase", "pausedHosts"]);
  return {
    token: typeof got.token === "string" ? got.token : "",
    apiBase: typeof got.apiBase === "string" && got.apiBase ? got.apiBase.replace(/\/+$/, "") : DEFAULT_API_BASE,
    pausedHosts: Array.isArray(got.pausedHosts) ? got.pausedHosts as string[] : [],
  };
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const { token, apiBase } = await config();
  return fetch(`${apiBase}${path}`, {
    method,
    headers: { [TOKEN_HEADER]: token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await call(method, path, body);
    const data = await res.json().catch(() => null) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, status: res.status, error: data?.error ?? `The app answered ${res.status}` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: "Can't reach the AI Applier app — is it running?" };
  }
}

async function resume(): Promise<ApiResult<ResumeFile>> {
  try {
    const res = await call("GET", "/ext/resume");
    if (!res.ok) return { ok: false, status: res.status, error: res.status === 404 ? "No resume in the app's Profile" : `The app answered ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const name = decodeURIComponent(res.headers.get("x-filename") ?? "Resume.pdf");
    return { ok: true, data: { name, type: res.headers.get("content-type") ?? "application/pdf", base64: btoa(bin) } };
  } catch {
    return { ok: false, status: 0, error: "Can't reach the AI Applier app — is it running?" };
  }
}

// --- Finished applications, kept until the app has them ---

async function pending(): Promise<PendingSubmit[]> {
  const got = await chrome.storage.local.get(PENDING);
  return Array.isArray(got[PENDING]) ? got[PENDING] as PendingSubmit[] : [];
}
const savePending = (list: PendingSubmit[]) => chrome.storage.local.set({ [PENDING]: list });

let flushing: Promise<void> | null = null;
let again = false;

/** Sends every due submission (learn first, then submitted); keeps those the app couldn't take for a later try. */
function flush(): Promise<void> {
  if (flushing) { again = true; return flushing; }
  flushing = (async () => {
    do {
      again = false;
      const now = Date.now();
      for (const p of await pending()) {
        if (p.due > now) continue;
        let done = false;
        if (p.learn && !p.learnDone) {
          const r = await api("POST", "/ext/learn", p.learn);
          if (r.ok || (r.status >= 400 && r.status < 500)) p.learnDone = true;
        } else p.learnDone = true;
        if (p.learnDone) {
          const r = await api("POST", "/ext/submitted", p.submitted);
          done = r.ok || (r.status >= 400 && r.status < 500 && r.status !== 401);
        }
        p.tries++;
        const list = await pending();
        const i = list.findIndex(x => x.id === p.id);
        if (i < 0) continue; // cancelled meanwhile
        if (done || p.tries >= MAX_TRIES) list.splice(i, 1);
        else list[i] = { ...p, due: Date.now() + Math.min(30_000 * p.tries, 5 * 60_000) }; // the app may be stopped: back off
        await savePending(list);
      }
      const rest = await pending();
      const next = rest.reduce((m, p) => Math.min(m, p.due), Infinity);
      if (Number.isFinite(next)) {
        schedule(Math.max(next - Date.now(), 0));
        // The worker may be stopped before the timer fires; an alarm wakes it again.
        if (rest.some(p => p.tries > 0)) void chrome.alarms?.create("retry", { delayInMinutes: 1 });
      }
    } while (again);
  })().finally(() => { flushing = null; });
  return flushing;
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flush(); }, ms + 50);
}

async function handle(msg: BgRequest): Promise<unknown> {
  switch (msg.type) {
    case "api":
      return api(msg.method, msg.path, msg.body);
    case "resume":
      return resume();
    case "submit": {
      const list = (await pending()).filter(p => p.id !== msg.id);
      list.push({ id: msg.id, due: Date.now() + msg.delayMs, tries: 0, learn: msg.learn, learnDone: false, submitted: msg.submitted });
      await savePending(list);
      schedule(msg.delayMs);
      return { ok: true };
    }
    case "submit-cancel":
      await savePending((await pending()).filter(p => p.id !== msg.id));
      return { ok: true };
    case "submit-commit": {
      const list = await pending();
      const p = list.find(x => x.id === msg.id);
      if (p) { p.due = Date.now(); await savePending(list); }
      await flush();
      return { ok: true };
    }
    case "get-config":
      return config();
    case "set-config": {
      const patch: Record<string, string> = {};
      if (msg.token !== undefined) patch.token = msg.token.trim();
      if (msg.apiBase !== undefined) patch.apiBase = msg.apiBase.trim().replace(/\/+$/, "");
      await chrome.storage.local.set(patch);
      return config();
    }
    case "site-paused": {
      const { pausedHosts } = await config();
      if (msg.paused === undefined) return pausedHosts.includes(msg.host);
      const next = pausedHosts.filter(h => h !== msg.host);
      if (msg.paused) next.push(msg.host);
      await chrome.storage.local.set({ pausedHosts: next });
      return msg.paused;
    }
  }
}

chrome.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse) => {
  handle(msg).then(sendResponse, e => sendResponse({ ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }));
  return true;
});
chrome.runtime.onStartup.addListener(() => { void flush(); });
chrome.runtime.onInstalled.addListener(() => { void flush(); });
chrome.alarms?.onAlarm.addListener(a => { if (a.name === "retry") void flush(); });
// A worker woken for any reason sends what is still waiting.
void flush();
