/**
 * The content script. On an application page (see scope.ts) it waits for the form, asks the app for every field's
 * answer, fills what the app knows, and lists what's left in a corner panel. When the user submits, what they typed is
 * sent back to the app (learn) with the submission. It never clicks submit, never fills a password, and never touches
 * a control outside the application form.
 */
import { followUpBox } from "../../src/answers/other.js";
import type { AdaptResponse, ExtAnswer, ExtHints, ExtResolution, LearnAnswer, ResolveResponse, SubmittedRequest } from "../../src/ext/protocol.js";
import { collectFields } from "../../src/forms/collect.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { fillField, isEmpty, isForbidden, membersOf, readValue, sameValue, type FieldValue, type FillDeps } from "./fill.js";
import { send, type ApiResult, type ResumeFile, type TabRequest, type TabState } from "./messages.js";
import { Panel, PANEL_HOST_ID, type DoneItem, type LeftItem } from "./panel.js";
import { composedContains, deepQueryAll, shadowRoots } from "./dom.js";
import { parsing, waitForParse } from "./parse.js";
import { refineFields } from "./refine.js";
import { findFormScope, inPageChrome, isApplicationPage, markScope, pageJob } from "./scope.js";
import { manualSections, type ManualSection } from "./sections.js";
import { PLACEHOLDER, sleep } from "./widgets.js";

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

interface FieldState {
  spec: FieldSpec;
  initial: FieldValue;
  res?: ExtResolution;
  /** What the extension put there (a fill that worked). */
  filledValue?: FieldValue;
  failed?: string;
  /** The real value was typed into the box "Other" revealed. */
  otherTyped?: boolean;
  /** Options to offer the user when the fill found none matching. */
  choices?: string[];
  /** The last value seen while the field was on the page (a multi-step form drops earlier steps' fields). */
  lastValue?: FieldValue;
  /** The user picked a quick-pick option (already sent to the app). */
  picked?: boolean;
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
  hints: ExtHints | null;
  manual: ManualSection[];
}

let session: Session | null = null;
let busy = false;
let filling = false;
let resumeFile: Promise<File | null> | null = null;

/** The page that led here (a one-click form's job posting), so the app can find the job by it. */
const referrer = (): { referrer?: string } => (/^https?:/.test(document.referrer) ? { referrer: document.referrer } : {});

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

const shownValue = (v: FieldValue): string => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : v ?? "");

/**
 * Every field's status, for the fields on the page now (a multi-step form's earlier steps are gone): what the extension
 * filled, and what's left for the user (still empty: a question only they can answer, a draft, or a fill that failed and
 * why, with options to pick).
 */
function tally(s: Session): { filled: number; left: LeftItem[]; done: DoneItem[] } {
  let filled = 0;
  const left: LeftItem[] = [];
  const done: DoneItem[] = [];
  for (const st of s.fields.values()) {
    const { spec, res } = st;
    const present = membersOf(spec.id).length > 0;
    // An upload Greenhouse replaced with the file's name still counts once it was attached.
    if (!present && !(spec.kind === "file" && st.filledValue !== undefined)) continue;
    if (!res || res.status === "skip") continue;
    const now = present ? valueOf(spec) : st.filledValue ?? null;
    if (present && !isEmpty(now)) st.lastValue = now;
    if ((res.status === "filled" || st.picked) && st.filledValue !== undefined && !st.failed) {
      filled++;
      outline(spec, isEmpty(now) ? "#c37d16" : "#057642");
      done.push({ fieldId: spec.id, label: spec.label, value: shownValue(isEmpty(now) ? st.filledValue : now) });
      if (res.status === "filled" && res.other && !st.otherTyped) left.push({ fieldId: spec.id, label: spec.label, required: spec.required, note: `Picked "Other": type "${res.other}" in its box` });
      continue;
    }
    if (!isEmpty(now) && !(spec.kind === "checkbox" && now === false)) { outline(spec, null); continue; }
    outline(spec, "#e07a00");
    const note = st.failed ? `Couldn't fill it: ${st.failed}` : res.status === "needs-you" ? NOTE[res.reason] ?? "Needs you" : "A draft is ready — check it";
    left.push({
      fieldId: spec.id, label: spec.label, required: spec.required, note, ...(st.failed ? { failed: true } : {}),
      ...(st.failed && st.choices?.length ? { choices: st.choices } : {}),
      ...(res.status === "suggestion" ? { suggestion: res.text } : {}),
    });
  }
  return { filled, left, done };
}

function render(): void {
  const s = session;
  if (!s) return;
  const { filled, left, done } = tally(s);
  s.manual = s.manual.filter(m => m.button.isConnected);
  s.panel.update({
    phase: s.phase, message: s.message, filled, total: filled + left.length, left, done,
    manual: s.manual.map((m, i) => ({ id: String(i), label: m.label })),
  });
}

let renderTimer: ReturnType<typeof setTimeout> | null = null;
function renderSoon(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
}

/** The application's fields inside the scope, never a password box or the panel's own controls. */
function scan(selector: string): FieldSpec[] {
  return refineFields(collectFields(selector), document.querySelector(selector)).filter(f => {
    const m = membersOf(f.id);
    return m.length && !m.some(isForbidden) && !m.some(e => e.closest(`#${PANEL_HOST_ID}`) || inPageChrome(e));
  });
}

/** How the extension fills a field: the resume, the profile's hints, and the app's mapping for unmatched options. */
function depsFor(s: Session, st: FieldState): FillDeps {
  const res = st.res?.status === "filled" ? st.res : null;
  return {
    resume,
    hints: s.hints,
    adapt: async ({ field, value, options, final }) => {
      const job = pageJob();
      const r = await bg<ApiResult<AdaptResponse>>({
        type: "api", method: "POST", path: "/ext/adapt",
        body: {
          url: location.href, ...referrer(), title: job.title, ...(job.company ? { company: job.company } : {}),
          field, value, options, final, ...(res ? { source: res.source, ...(res.entity ? { entity: true } : {}) } : {}),
        },
      });
      return r?.ok ? r.data : null;
    },
  };
}

/** Fills one field and records how it went; a picked "Other" gets its real value typed into the box it reveals. */
async function fillOne(s: Session, st: FieldState, answer: ExtAnswer): Promise<boolean> {
  const out = await fillField(st.spec, answer, depsFor(s, st));
  if (session !== s) return false;
  if (!out.ok) {
    st.failed = out.error;
    st.choices = out.choices;
    return false;
  }
  st.failed = undefined;
  st.choices = undefined;
  st.filledValue = out.value;
  const other = out.other ?? (st.res?.status === "filled" ? st.res.other : undefined);
  if (other) {
    if (out.other && st.res?.status === "filled") st.res = { ...st.res, other: out.other };
    await fillOtherBox(s, st, other);
  }
  return true;
}

/**
 * Types the real value into the box that "Other" revealed (or the "please specify" box after the control), as the runner
 * does (answers/other.ts followUpBox): it is filled from the same source, never asked about as a new question.
 */
async function fillOtherBox(s: Session, control: FieldState, value: string): Promise<void> {
  await sleep(300); // let the form show the box
  const present = scan(s.selector);
  const box = followUpBox(present, control.spec.id, id => s.fields.get(id)?.filledValue !== undefined);
  if (!box) return;
  const spec: FieldSpec = { ...box };
  const res: ExtResolution = { fieldId: spec.id, status: "filled", answer: { type: "text", text: value }, source: control.res?.status === "filled" ? control.res.source : "bank" };
  const st: FieldState = s.fields.get(spec.id) ?? { spec, initial: valueOf(spec) };
  st.res = res;
  s.fields.set(spec.id, st);
  const out = await fillField(spec, res.answer, depsFor(s, st));
  if (out.ok) { st.filledValue = out.value; control.otherTyped = true; } else st.failed = out.error;
}

async function resolveAndFill(s: Session, specs: FieldSpec[]): Promise<void> {
  for (const spec of specs) if (!s.fields.has(spec.id)) s.fields.set(spec.id, { spec, initial: valueOf(spec) });
  const job = pageJob();
  const r = await bg<ApiResult<ResolveResponse>>({
    type: "api", method: "POST", path: "/ext/resolve",
    body: { url: location.href, ...referrer(), title: job.title, ...(job.company ? { company: job.company } : {}), fields: specs },
  });
  if (session !== s) return;
  if (!r || !r.ok) {
    s.phase = "error";
    s.message = !r ? "The extension was updated — reload this page."
      : r.status === 401 ? "Pair the extension: open its popup and paste the token from the app's Settings." : r.error;
    render();
    return;
  }
  s.hints = r.data.hints ?? s.hints;
  filling = true;
  try {
    const todo: FieldState[] = [];
    for (const res of r.data.resolutions) {
      const st = s.fields.get(res.fieldId);
      if (!st) continue;
      st.res = res;
      st.failed = undefined;
      if (res.status === "filled") todo.push(st);
    }
    // A resume parser (Lever, Ashby) rewrites fields after an upload, or may still be running from the user's own
    // upload: the files go first, then everything else once it's done.
    const files = todo.filter(st => st.spec.kind === "file");
    if (parsing(s.scope)) { s.message = "Waiting for the site to read the resume…"; render(); await waitForParse(s.scope, false); }
    for (const st of files) {
      if (session !== s) return;
      await fillOne(s, st, (st.res as { answer: ExtAnswer }).answer);
    }
    if (files.length) {
      s.message = "Waiting for the site to read the resume…";
      render();
      await waitForParse(s.scope, true);
    }
    s.message = "Filling…";
    for (const st of todo) {
      if (session !== s) return;
      if (st.spec.kind === "file") continue;
      render();
      await fillOne(s, st, (st.res as { answer: ExtAnswer }).answer);
    }
  } finally {
    filling = false;
  }
  s.manual = manualSections(s.scope);
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
  // Workday splits the application into steps, some with one or two questions (its sign-in has a password: never taken).
  const min = force ? FORCED_MIN_FIELDS : location.hostname.endsWith(".myworkdayjobs.com") ? 1 : MIN_FIELDS;
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
      url: location.href, scope, selector, fields: new Map(),
      panel: new Panel({ focus: focusField, useSuggestion, pick: (id, option) => void quickPick(id, option), focusManual, refill: () => void activate(true), pauseSite }),
      phase: "working", message: "Working out your answers…", submitId: null, hints: null, manual: [],
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

function focusManual(id: string): void {
  const m = session?.manual[Number(id)];
  m?.button.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * The user picked one of the options offered for a field the extension couldn't fill: it is filled with that option and
 * sent to the app at once (/ext/learn), so this question takes that answer next time (and this job keeps it).
 */
async function quickPick(id: string, option: string): Promise<void> {
  const s = session;
  const st = s?.fields.get(id);
  if (!s || !st) return;
  const before = st.res?.status === "filled" ? st.res : null;
  const replaced = before && (before.answer.type === "text" || before.answer.type === "option") ? (before.answer.type === "text" ? before.answer.text : before.answer.option) : undefined;
  filling = true;
  let ok = false;
  try {
    ok = await fillOne(s, st, { type: "option", option });
  } finally {
    filling = false;
  }
  if (ok) {
    st.picked = true;
    const res = st.res;
    const job = pageJob();
    const value = valueOf(st.spec);
    void bg({
      type: "api", method: "POST", path: "/ext/learn",
      body: {
        url: location.href, ...referrer(), ...job,
        answers: [{
          label: st.spec.label, kind: st.spec.kind, ...(st.spec.options?.length ? { options: st.spec.options } : {}),
          value: isEmpty(value) ? option : value as string | string[] | boolean,
          // The app's own value (a profile fact) stays the profile's: the pick is remembered for this question only.
          source: before?.source ?? "pick", ...(replaced ? { replaced } : {}),
          ...(res && "questionId" in res && res.questionId !== undefined ? { questionId: res.questionId } : {}),
        }],
      },
    });
  }
  render();
}

async function useSuggestion(id: string): Promise<void> {
  const s = session;
  const st = s?.fields.get(id);
  if (!s || !st || st.res?.status !== "suggestion") return;
  filling = true;
  try {
    const out = await fillField(st.spec, st.res.suggestion, depsFor(s, st));
    if (!out.ok && st.res.suggestion.type !== "text") await fillField(st.spec, { type: "text", text: st.res.text }, depsFor(s, st));
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
    if (spec.kind === "file" || st.picked) continue;
    const v = membersOf(spec.id).length ? valueOf(spec) : st.lastValue ?? null;
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
    const v = membersOf(st.spec.id).length ? valueOf(st.spec) : st.lastValue ?? (st.spec.kind === "file" ? st.filledValue ?? null : null);
    if (isEmpty(v)) continue;
    if (st.spec.kind === "file" && st.res?.status === "filled" && typeof v === "string") resumeUsed = v;
    answers.push({ label: st.spec.label, value: v as string | string[] | boolean });
  }
  return { url: s.url, ...referrer(), title: job.title, company: job.company ?? "", ...(resumeUsed ? { resumeUsed } : {}), answers };
}

/** Error messages the form shows (a submit it refused adds some). */
function errorCount(scope: Element): number {
  return deepQueryAll(scope, '[role=alert], .error, [class*="error" i], [class*="invalid" i]')
    .filter(e => visible(e) && !!e.textContent?.trim()).length;
}

/** Whether the form refused the submit: a control marked invalid, or more error messages than before the click. */
function refused(scope: Element, errorsBefore: number): boolean {
  if (!visible(scope)) return false;
  if (deepQueryAll(scope, '[aria-invalid="true"], input:invalid, select:invalid, textarea:invalid').some(visible)) return true;
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
  await bg({ type: "submit", id, learn: learn.length ? { url: s.url, ...referrer(), ...pageJob(), answers: learn } : null, submitted: submission(s), delayMs: SUBMIT_DELAY_MS });
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

/** A button's words: its own text or label, else (a <button> inside a web component) its host's. */
function buttonText(el: Element): string {
  const own = squashed(el instanceof HTMLInputElement ? el.value : el.textContent || el.getAttribute("aria-label"));
  if (own) return own;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? squashed(root.host.textContent || root.host.getAttribute("aria-label")) : "";
}
const squashed = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function isSubmitControl(el: Element): boolean {
  const s = session;
  if (!s) return false;
  const text = buttonText(el);
  if (!text || text.length > 60 || !SUBMIT_TEXT.test(text) || NOT_SUBMIT.test(text)) return false;
  // Inside the form (through shadow roots), or next to it (a form-less page may keep its button beside the fields).
  const near = s.scope.parentElement?.parentElement ?? s.scope;
  return composedContains(s.scope, el) || (composedContains(near, el) && !inPageChrome(el));
}

const BUTTON = "button, input[type=submit], input[type=button], [role=button], a";

document.addEventListener("click", e => {
  if (!session) return;
  // A click inside a shadow root reaches the document retargeted to its host: the real target is in the path.
  const path = e.composedPath().filter((n): n is Element => n instanceof Element);
  if (!path.length || path.some(n => n.id === PANEL_HOST_ID)) return;
  const b = path.find(n => n.matches(BUTTON) || /-button$/i.test(n.tagName));
  if (b && isSubmitControl(b)) void onSubmit();
  else renderSoon();
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
  observeAll();
  // The page changed while filling: look again once that's done.
  if (busy || filling) { recheck = true; return; }
  const s = session;
  // A single-page app moved on, or the page re-rendered the form (a framework hydrating the page replaces it). A form
  // replaced by its thank-you page right after a submit is not that: the session stays to record it and say so.
  if (s && ((!s.submitId && (s.url !== location.href || !s.scope.isConnected)) || (s.phase === "submitted" && s.url !== location.href))) teardown();
  if (!session) {
    if (autoPage()) await activate(false);
    return;
  }
  if (session.phase !== "done" || session.submitId) return;
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
let observer: MutationObserver | null = null;
const observed = new WeakSet<Node>();
const OBSERVE: MutationObserverInit = { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class", "aria-hidden"] };

/** Watches the page and every open shadow root in it (changes inside a shadow root don't reach the page's observer). */
function observeAll(): void {
  if (!observer) return;
  for (const root of [document.documentElement as Node, ...shadowRoots()]) {
    if (observed.has(root)) continue;
    observed.add(root);
    observer.observe(root, OBSERVE);
  }
}

/** How often the page is looked at anyway: web components can render late without a change the observers see. */
const RESCAN_MS = 2000;

function watch(): void {
  if (watching) return;
  watching = true;
  observer = new MutationObserver(records => {
    if (records.every(r => r.target instanceof Element && r.target.closest(`#${PANEL_HOST_ID}`))) return;
    scheduleScan(QUIET_MS);
  });
  observeAll();
  setInterval(() => {
    if (document.visibilityState !== "visible" || busy || filling || pausedHere) return;
    if (!session && !autoPage()) return;
    observeAll();
    if (!scanTimer) scheduleScan(0);
  }, RESCAN_MS);
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
