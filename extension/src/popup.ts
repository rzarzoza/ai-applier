/** The toolbar popup (also the options page): pairing, the app's status, "Fill this page", and pausing a site. */
import type { StatusResponse } from "../../src/ext/protocol.js";
import { send, type ApiResult, type Config, type TabState } from "./messages.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const tokenEl = $<HTMLInputElement>("token");
const apiEl = $<HTMLInputElement>("api");
const siteBtn = $<HTMLButtonElement>("site");
const pageEl = $("page");

if (location.search.includes("page") || window.innerWidth > 500) document.body.classList.add("page");

function setStatus(text: string, kind: "ok" | "err" | "" = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function checkApp() {
  const r = await send<ApiResult<StatusResponse>>({ type: "api", method: "GET", path: "/ext/status" });
  if (!r.ok) {
    setStatus(r.error, "err");
    if (r.status === 401) ($("pairing") as HTMLDetailsElement).open = true;
    return;
  }
  const notes = [r.data.profileComplete ? "profile ready" : "finish your Profile in the app", r.data.hasResume ? "" : "no resume uploaded"].filter(Boolean);
  setStatus(`Connected · ${notes.join(" · ")}`, r.data.profileComplete ? "ok" : "");
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function showSite() {
  const tab = await activeTab();
  let host = "";
  try { host = tab?.url ? new URL(tab.url).hostname : ""; } catch { /* no page */ }
  if (!host || !tab?.url?.startsWith("http")) { siteBtn.hidden = true; return; }
  const paused = await send<boolean>({ type: "site-paused", host });
  siteBtn.hidden = false;
  siteBtn.textContent = paused ? `Resume on ${host}` : `Pause on ${host}`;
  siteBtn.onclick = async () => {
    await send({ type: "site-paused", host, paused: !paused });
    await showSite();
  };
  if (tab.id !== undefined) {
    const state = await chrome.tabs.sendMessage(tab.id, { type: "state" }).catch(() => null) as TabState | null;
    pageEl.textContent = state?.active ? `This page: filled ${state.filled} of ${state.total}${state.left ? ` · ${state.left} need you` : ""}` : "";
  }
}

$("fill").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab?.id === undefined) return;
  const r = await chrome.tabs.sendMessage(tab.id, { type: "fill" }).catch(() => null) as { ok: boolean } | null;
  pageEl.textContent = r?.ok ? "Filling — see the panel on the page." : "No form to fill here (or the page needs a reload after installing).";
});

$("save").addEventListener("click", async () => {
  await send<Config>({ type: "set-config", token: tokenEl.value, apiBase: apiEl.value });
  setStatus("Saved. Checking…");
  await checkApp();
});

void (async () => {
  const cfg = await send<Config>({ type: "get-config" });
  tokenEl.value = cfg.token;
  apiEl.value = cfg.apiBase;
  if (!cfg.token) ($("pairing") as HTMLDetailsElement).open = true;
  await Promise.all([checkApp(), showSite()]);
})();
