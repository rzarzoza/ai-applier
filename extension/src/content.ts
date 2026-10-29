/**
 * The content script. On an application page (see scope.ts) it waits for the form, asks the app for every field's
 * answer, fills what the app knows, and lists what's left in a corner panel. When the user submits, what they typed is
 * sent back to the app (learn) with the submission. It never clicks submit, never fills a password, and never touches
 * a control outside the application form.
 */
import type { ExtResolution, LearnAnswer, ResolveResponse, SubmittedRequest } from "../../src/ext/protocol.js";
import { collectFields } from "../../src/forms/collect.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { fillField, isEmpty, isForbidden, membersOf, readValue, sameValue, type FieldValue } from "./fill.js";
import { send, type ApiResult, type ResumeFile, type TabRequest, type TabState } from "./messages.js";
import { Panel, PANEL_HOST_ID, type LeftItem } from "./panel.js";
import { refineFields } from "./refine.js";
import { findFormScope, isApplicationPage, markScope, pageJob } from "./scope.js";

const MIN_FIELDS = 3;
/** "Fill this page" takes a smaller form, but not a lone search box. */
const FORCED_MIN_FIELDS = 2;
const SUBMIT_TEXT = /submit|apply|send application/i;
const NOT_SUBMIT = /linkedin|indeed|autofill|with google|upload|attach|sign in|log in|save for later/i;
/** How long after a submit click the form gets to refuse it (validation errors) before it counts as sent. */
const SUBMIT_CHECK_MS = 2500;
const SUBMIT_DELAY_MS = 4000;
/** How long the page must stay unchanged before the extension starts (or looks for new fields). */
const QUIET_MS = 700;
const MAX_WAIT_MS = 3000;
/** A combobox showing one of these shows no value. */
const PLACEHOLDER = /^(select|choose|pick|start typing|search)\b.*|^-+$/i;

interface FieldState {
  spec: FieldSpec;
  initial: FieldValue;
  res?: ExtResolution;
  /** What the extension put there (a fill that worked). */
  filledValue?: FieldValue;
  failed?: string;
}

interface Session {
  url: string;
  scope: Element;
  selector: string;
  fields: Map<string, FieldState>;
  panel: Panel;
  phase: "working" | "done" | "error" | "submitted";
  message?: string;
  submitId: string | null;
}

let session: Session | null = null;
let busy = false;
let filling = false;
let resumeFile: Promise<File | null> | null = null;

const outlined = new Map<HTMLElement, SavedOutline>();
const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;

async function bg<T>(msg: Parameters<typeof send>[0]): Promise<T | null> {
  try { return await send<T>(msg); } catch { return null; }
}

function resume(): Promise<File | null> {
  resumeFile ??= (async () => {
    const r = await bg<ApiResult<ResumeFile>>({ type: "resume" });
    if (!r?.ok) return null;
    const bin = atob(r.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], r.data.name, { type: r.data.type });
  })();
  return resumeFile;
}

/** The element to outline or scroll to for a field: a group's box, a hidden upload's button, else the control. */
function targetOf(spec: FieldSpec): HTMLElement | null {
  const members = membersOf(spec.id);
  const el = members[0];
  if (!el) return null;
  if (spec.kind === "radio" || spec.kind === "checkbox-group") {
    return el.closest<HTMLElement>("fieldset, [role=radiogroup], [role=group]") ?? el.parentElement;
  }
  if (spec.kind === "checkbox") return el.closest<HTMLElement>("label") ?? el;
  if (spec.kind === "combobox" && el instanceof HTMLInputElement) {
    // A react-select style picker: its visible box, not the narrow search input inside it.
    for (let a = el.parentElement, d = 0; a && d < 4; a = a.parentElement, d++) {
      if (a.querySelectorAll("[role=combobox]").length > 1) break;
      if (/(^|[\s_-])control(\s|$)|__control/i.test(a.getAttribute("class") ?? "")) return a;
    }
  }
  if (!visible(el)) {
    for (let a = el.parentElement, d = 0; a && d < 3; a = a.parentElement, d++) if (visible(a)) return a;
  }
  return el;
}

/** The outline a control had before the extension marked it, to put back. */
interface SavedOutline { outline: string; outlinePriority: string; offset: string }

function restore(el: HTMLElement, prev: SavedOutline): void {
  el.style.setProperty("outline", prev.outline, prev.outlinePriority);
  if (!prev.outline) el.style.removeProperty("outline");
  if (prev.offset) el.style.setProperty("outline-offset", prev.offset);
  else el.style.removeProperty("outline-offset");
}

function outline(spec: FieldSpec, color: string | null): void {
  const t = targetOf(spec);
  if (!t) return;
  if (!outlined.has(t)) {
    outlined.set(t, { outline: t.style.getPropertyValue("outline"), outlinePriority: t.style.getPropertyPriority("outline"), offset: t.style.getPropertyValue("outline-offset") });
  }
  if (color) {
    // Important, so a site rule like "outline: none !important" on its pickers doesn't hide it; drawn inside the box,
    // so a wrapper with overflow hidden doesn't clip it.
    t.style.setProperty("outline", `2px solid ${color}`, "important");
    t.style.setProperty("outline-offset", "-2px", "important");
  } else {
    restore(t, outlined.get(t)!);
    outlined.delete(t);
  }
}

function clearOutlines(): void {
  for (const [el, prev] of outlined) restore(el, prev);
  outlined.clear();
}

const valueOf = (spec: FieldSpec): FieldValue => {
  const v = readValue(spec);
  if (spec.kind === "combobox" && typeof v === "string" && PLACEHOLDER.test(v.trim())) return null;
  return v;
};

const NOTE: Record<string, string> = {
  missing: "Only you can answer this — it'll be saved for next time",
  approval: "Needs your OK",
  file: "Attach this file yourself",
};

/** What's left for the user (still empty), and how many fields the extension filled. */
function tally(s: Session): { filled: number; left: LeftItem[] } {
  let filled = 0;
  const left: LeftItem[] = [];
  for (const st of s.fields.values()) {
    const { spec, res } = st;
    if (!res || res.status === "skip") continue;
    const now = valueOf(spec);
    if (res.status === "filled" && st.filledValue !== undefined && !st.failed) {
      filled++;
      outline(spec, isEmpty(now) ? "#c37d16" : "#057642");
      if (res.other) left.push({ fieldId: spec.id, label: spec.label, required: spec.required, note: `Picked "Other": type "${res.other}" in its box` });
      continue;
    }
    if (!isEmpty(now) && !(spec.kind === "checkbox" && now === false)) { outline(spec, null); continue; }
    outline(spec, "#e07a00");
    const note = st.failed ? `Couldn't fill it: ${st.failed}` : res.status === "needs-you" ? NOTE[res.reason] ?? "Needs you" : "A draft is ready — check it";
    left.push({
      fieldId: spec.id, label: spec.label, required: spec.required, note,
      ...(res.status === "suggestion" ? { suggestion: res.text } : {}),
    });
  }
  return { filled, left };
}

function render(): void {
  const s = session;
  if (!s) return;
  const { filled, left } = tally(s);
  s.panel.update({ phase: s.phase, message: s.message, filled, total: filled + left.length, left });
}

let renderTimer: ReturnType<typeof setTimeout> | null = null;
function renderSoon(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

/** The application's fields inside the scope, never a password box or the panel's own controls. */
function scan(selector: string): FieldSpec[] {
  return refineFields(collectFields(selector)).filter(f => {
    const m = membersOf(f.id);
    return m.length && !m.some(isForbidden) && !m.some(e => e.closest(`#${PANEL_HOST_ID}`));
  });
}

async function resolveAndFill(s: Session, specs: FieldSpec[]): Promise<void> {
  for (const spec of specs) if (!s.fields.has(spec.id)) s.fields.set(spec.id, { spec, initial: valueOf(spec) });
  const job = pageJob();
  const r = await bg<ApiResult<ResolveResponse>>({
    type: "api", method: "POST", path: "/ext/resolve",
    body: { url: location.href, title: job.title, ...(job.company ? { company: job.company } : {}), fields: specs },
  });
  if (session !== s) return;
  if (!r || !r.ok) {
    s.phase = "error";
    s.message = !r ? "The extension was updated — reload this page."
      : r.status === 401 ? "Pair the extension: open its popup and paste the token from the app's Settings." : r.error;
    render();
    return;
  }
  filling = true;
  try {
    for (const res of r.data.resolutions) {
      const st = s.fields.get(res.fieldId);
      if (!st) continue;
      st.res = res;
      st.failed = undefined;
      if (res.status !== "filled") continue;
      const out = await fillField(st.spec, res.answer, { resume });
      if (session !== s) return;
      if (out.ok) st.filledValue = out.value;
      else st.failed = out.error;
    }
  } finally {
    filling = false;
  }
  s.phase = "done";
  s.message = undefined;
  render();
  // The page re-rendered the form while it was being filled: start over on the new one.
  if (!s.scope.isConnected) recheck = true;
}

/** Starts on this page's application form; with `force` (the popup's "Fill this page"), on any form, starting over. */
async function activate(force: boolean): Promise<boolean> {
  if (busy) return false;
  if (session && !force) return true;
  const min = force ? FORCED_MIN_FIELDS : MIN_FIELDS;
  const scope = findFormScope(min, force || autoPage());
  if (!scope) return false;
  const selector = markScope(scope);
  const specs = scan(selector);
  if (specs.length < min) return false;
  watch();
  busy = true;
  try {
    teardown();
    const s: Session = {
      url: location.href, scope, selector, fields: new Map(), panel: new Panel({ focus: focusField, useSuggestion, refill: () => void activate(true), pauseSite }),
      phase: "working", message: "Working out your answers…", submitId: null,
    };
    session = s;
    render();
    await resolveAndFill(s, specs);
    return true;
  } finally {
    busy = false;
    afterBusy();
  }
}

function teardown(): void {
  clearOutlines();
  session?.panel.remove();
  session = null;
}

function focusField(id: string): void {
  const st = session?.fields.get(id);
  if (!st) return;
  const t = targetOf(st.spec);
  t?.scrollIntoView({ block: "center", behavior: "smooth" });
  const el = membersOf(id)[0];
  try { (el && visible(el) ? el : t)?.focus({ preventScroll: true }); } catch { /* not focusable */ }
}

async function useSuggestion(id: string): Promise<void> {
  const s = session;
  const st = s?.fields.get(id);
  if (!s || !st || st.res?.status !== "suggestion") return;
  filling = true;
  try {
    const out = await fillField(st.spec, st.res.suggestion, { resume });
    if (!out.ok && st.res.suggestion.type !== "text") await fillField(st.spec, { type: "text", text: st.res.text }, { resume });
  } finally {
    filling = false;
  }
  render();
}

async function pauseSite(): Promise<void> {
  pausedHere = true;
  await bg({ type: "site-paused", host: location.hostname, paused: true });
  teardown();
}

// --- Learning: what the user typed, sent when they submit ---

function learnAnswers(s: Session): LearnAnswer[] {
  const out: LearnAnswer[] = [];
  for (const st of s.fields.values()) {
    const { spec, res } = st;
    if (spec.kind === "file") continue;
    const v = valueOf(spec);
    if (isEmpty(v) || sameValue(v, st.initial)) continue;
    const appFilled = res?.status === "filled" && st.filledValue !== undefined;
    if (appFilled && sameValue(v, st.filledValue!)) continue;
    out.push({
      label: spec.label, kind: spec.kind, ...(spec.options?.length ? { options: spec.options } : {}), value: v as string | string[] | boolean,
      source: appFilled ? (res as { source: string }).source : res?.status === "suggestion" ? "suggestion" : "none",
      ...(res && "questionId" in res && res.questionId !== undefined ? { questionId: res.questionId } : {}),
    });
  }
  return out;
}

function submission(s: Session): SubmittedRequest {
  const job = pageJob();
  let resumeUsed: string | undefined;
  const answers: { label: string; value: string | string[] | boolean }[] = [];
  for (const st of s.fields.values()) {
    const v = valueOf(st.spec);
    if (isEmpty(v)) continue;
    if (st.spec.kind === "file" && st.res?.status === "filled" && typeof v === "string") resumeUsed = v;
    answers.push({ label: st.spec.label, value: v as string | string[] | boolean });
  }
  return { url: s.url, title: job.title, company: job.company ?? "", ...(resumeUsed ? { resumeUsed } : {}), answers };
}

/** Error messages the form shows (a submit it refused adds some). */
function errorCount(scope: Element): number {
  return Array.from(scope.querySelectorAll('[role=alert], .error, [class*="error" i], [class*="invalid" i]'))
    .filter(e => visible(e) && !!e.textContent?.trim()).length;
}

/** Whether the form refused the submit: a control marked invalid, or more error messages than before the click. */
function refused(scope: Element, errorsBefore: number): boolean {
  if (!visible(scope)) return false;
  if (Array.from(scope.querySelectorAll('[aria-invalid="true"], input:invalid, select:invalid, textarea:invalid')).some(visible)) return true;
  return errorCount(scope) > errorsBefore;
}

async function onSubmit(): Promise<void> {
  const s = session;
  if (!s || s.submitId || s.phase === "submitted") return;
  // crypto.randomUUID needs a secure context, and a careers page may be plain http.
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  s.submitId = id;
  const errorsBefore = errorCount(s.scope);
  const learn = learnAnswers(s);
  // Sent first, so the background keeps it even if the page navigates away right now.
  await bg({ type: "submit", id, learn: learn.length ? { url: s.url, ...pageJob(), answers: learn } : null, submitted: submission(s), delayMs: SUBMIT_DELAY_MS });
  setTimeout(() => {
    if (session !== s) return;
    if (s.scope.isConnected && refused(s.scope, errorsBefore)) {
      void bg({ type: "submit-cancel", id });
      s.submitId = null;
      s.message = "The form didn't accept it yet: fix the marked fields and submit again.";
      render();
      return;
    }
    void bg({ type: "submit-commit", id });
    s.phase = "submitted";
    s.message = learn.length ? `Saved ${learn.length} new answer${learn.length === 1 ? "" : "s"} to your bank.` : undefined;
    clearOutlines();
    render();
  }, SUBMIT_CHECK_MS);
}

function isSubmitControl(el: Element): boolean {
  const s = session;
  if (!s) return false;
  const text = (el instanceof HTMLInputElement ? el.value : el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 60 || !SUBMIT_TEXT.test(text) || NOT_SUBMIT.test(text)) return false;
  // Inside the form, or next to it (a form-less page may keep its button beside the fields' block).
  const near = s.scope.parentElement?.parentElement ?? s.scope;
  return s.scope.contains(el) || (near.contains(el) && !el.closest("header, nav, footer"));
}

document.addEventListener("click", e => {
  const t = e.target instanceof Element ? e.target : null;
  if (t && session && !t.closest(`#${PANEL_HOST_ID}`)) {
    const b = t.closest("button, input[type=submit], input[type=button], [role=button], a");
    if (b && isSubmitControl(b)) void onSubmit();
    else renderSoon();
  }
}, true);
document.addEventListener("submit", e => {
  const f = e.target instanceof Element ? e.target : null;
  if (f && session && (f === session.scope || f.contains(session.scope) || session.scope.contains(f))) void onSubmit();
}, true);
for (const type of ["input", "change"]) document.addEventListener(type, () => { if (session && !filling) renderSoon(); }, true);

// --- Waking up ---

/** This page wakes the extension by itself (a company page counts through its embedded Greenhouse frame). */
function autoPage(): boolean {
  const url = new URL(location.href);
  if (!isApplicationPage(url)) return false;
  if (window !== window.top) return true;
  url.searchParams.delete("gh_jid");
  return isApplicationPage(url);
}

let scanTimer: ReturnType<typeof setTimeout> | null = null;
let pausedHere = false;

/** After the page changes: start once a form shows, follow a single-page app to its next page, fill fields that appear. */
async function onPageChange(): Promise<void> {
  if (pausedHere) return;
  // The page changed while filling: look again once that's done.
  if (busy || filling) { recheck = true; return; }
  const s = session;
  // A single-page app moved on, or the page re-rendered the form (a framework hydrating the page replaces it).
  if (s && ((s.url !== location.href && !s.submitId) || !s.scope.isConnected)) teardown();
  if (!session) {
    if (autoPage()) await activate(false);
    return;
  }
  if (session.phase !== "done") return;
  const fresh = scan(session.selector).filter(f => !session!.fields.has(f.id));
  if (fresh.length) {
    busy = true;
    try { await resolveAndFill(session, fresh); } finally { busy = false; afterBusy(); }
  }
}

let recheck = false;
/** Runs the check the page asked for while the extension was busy. */
function afterBusy(): void {
  if (!recheck) return;
  recheck = false;
  scheduleScan(300);
}

let scanSince = 0;
/** Looks at the page once it has been quiet for `ms`, or after MAX_WAIT_MS of constant change (an animated page). */
function scheduleScan(ms: number): void {
  const now = Date.now();
  if (scanTimer) clearTimeout(scanTimer);
  else scanSince = now;
  scanTimer = setTimeout(() => { scanTimer = null; void onPageChange(); }, now - scanSince > MAX_WAIT_MS ? 0 : ms);
}

let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  const observer = new MutationObserver(records => {
    if (records.every(r => r.target instanceof Element && r.target.closest(`#${PANEL_HOST_ID}`))) return;
    scheduleScan(QUIET_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class", "aria-hidden"] });
}

chrome.runtime.onMessage.addListener((msg: TabRequest, _sender, sendResponse) => {
  if (msg.type === "fill") {
    pausedHere = false;
    activate(true).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "state") {
    const t = session ? tally(session) : { filled: 0, left: [] };
    const state: TabState = { active: !!session, filled: t.filled, total: t.filled + t.left.length, left: t.left.length };
    sendResponse(state);
  }
  return false;
});

void (async () => {
  if (!autoPage()) return;
  pausedHere = (await bg<boolean>({ type: "site-paused", host: location.hostname })) === true;
  if (pausedHere) return;
  // Start once the page has settled: a page that hydrates (React, Remix) re-renders its form right after loading,
  // which would drop whatever was filled before it. The observer restarts the wait on every change.
  watch();
  scheduleScan(QUIET_MS);
})();
