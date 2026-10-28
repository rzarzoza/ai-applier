/**
 * Lever handler. Selectors confirmed against live jobs.lever.co / jobs.eu.lever.co apply pages (Oct 2026):
 * - the application form is at `<posting>/apply`: `form#application-form` (no iframe). The apply page shows only the
 *   posting header (`.posting-header`), not the job description. A missing/closed posting is HTTP 404 ("Sorry, we
 *   couldn't find anything here ... might have closed").
 * - each question is `li.application-question` > `label` > `.application-label` (+ `span.required` "✱") and
 *   `.application-field`. Extracted labels would otherwise keep the "✱" and, for the resume, the widget text.
 * - single name field: `input[name=name]` "Full name"; `input[name=email]`; `input[name=phone]`; `input[name=org]`;
 *   `input#location-input[name=location]` (plain text, an autocomplete dropdown is optional).
 * - links: `input[name="urls[LinkedIn|Twitter|GitHub|Portfolio|Other]"]` (type=text, not url).
 * - resume: `input#resume-upload-input[name=resume][type=file]` (class invisible-resume-upload) inside an
 *   `a.visible-resume-upload`; Lever parses the resume after upload: `.resume-upload-working` ("Analyzing resume...")
 *   shows while it runs, then `.resume-upload-success` / `-failure`, and the hidden `input[name=resumeStorageId]` gets a
 *   value. The parse result is written into the form (it may clear "Current location" or replace "Current company"), so
 *   nothing else is filled until it has finished (see afterUpload).
 * - custom question "cards": hidden `cards[<id>][baseTemplate]` JSON + inputs `cards[<id>][fieldN]`:
 *   `input[type=radio]` (multiple-choice), `input.card-field-input`, `textarea.card-field-input`.
 * - select2 pickers (university question): hidden `select.select2-hidden-accessible` + `span.select2-selection[role=combobox]`
 *   (aria-owns -> results `li.select2-results__option[role=treeitem]`, search `input.select2-search__field`); the real value is the hidden select.
 * - EEO/survey: `select[name="eeo[gender|race|veteran|disability...]"]`, and `surveysResponses[<id>][responses][fieldN]` radios.
 * - submit: `button#btn-submit[type=button][data-qa=btn-submit]` "Submit application" (a click executes hCaptcha, then
 *   clicks the hidden `button#hcaptchaSubmitBtn[type=submit].hidden`).
 * - hCaptcha is invisible (`div#h-captcha.h-captcha`, hidden `input#hcaptchaResponseInput`); a challenge only appears as
 *   a visible `iframe[src*=hcaptcha][title*=challenge]`.
 * - validation errors: `.error-message` (only visible ones count; `.resume-upload-oversize .error-message` is hidden
 *   until triggered) and `[aria-invalid=true]`. Native `required` bubbles are not DOM and are not read.
 * - success: URL path ends `/thanks`.
 */
import type { Frame, Page } from "playwright";
import { extractFields } from "../forms/extract.js";
import { fillField, readBack as readBackField, readOptions as readOptionsField } from "../forms/fill.js";
import { inPage } from "../forms/in-page.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "./types.js";

const HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const FORM = "form#application-form";
const BOT_WALL = /just a moment|security check to continue|verify (that )?you are (a )?human|access denied|attention required/i;
const CLOSED = /no longer (open|available|accepting)|(job|position|posting) (has been )?(closed|filled)/i;
const DESCRIPTION_MAX = 8000;
/** Longest wait for Lever's resume parser after an upload. */
const PARSE_WAIT_MS = 30_000;
/** How long the "Analyzing resume" indicator gets to appear after the upload before Lever is taken to have no parser. */
const PARSE_START_MS = 3_000;
/** Lets the page apply the parse result (it writes fields right after hiding the indicator). */
const PARSE_SETTLE_MS = 500;

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

const isLeverHost = (url: string) => HOSTS.has(parse(url)?.hostname ?? "");
const endsWith = (url: string, segment: string) => new RegExp(`/${segment}/*$`).test(parse(url)?.pathname ?? "");

/** `https://jobs.lever.co/<co>/<id>[/][?q]` -> `.../apply[?q]`; null when the URL is not a posting. */
function applyUrl(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[2] !== "apply") u.pathname = `/${parts.slice(0, 2).join("/")}/apply`;
  return u.toString();
}

export const lever: AtsHandler = {
  name: "lever",

  matches(url) {
    return isLeverHost(url);
  },

  async open(page, url): Promise<OpenResult> {
    const target = applyUrl(url);
    if (!target) return { ok: false, reason: "not-found", detail: `not a Lever posting URL: ${url}` };
    const resp = await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const status = resp?.status() ?? 0;
    if (status === 404) return { ok: false, reason: "closed", detail: `HTTP 404 at ${page.url()} (posting closed or removed)` };
    if (await page.locator(FORM).first().isVisible()) return { ok: true };
    const text = await page.locator("body").innerText().catch(() => "");
    if (CLOSED.test(text)) return { ok: false, reason: "closed", detail: "job is no longer accepting applications" };
    if (status === 403 || status === 429 || BOT_WALL.test(`${await page.title().catch(() => "")}\n${text}`)) {
      return { ok: false, reason: "blocked", detail: `bot wall (HTTP ${status}) at ${page.url()}` };
    }
    return { ok: false, reason: "blocked", detail: `${status >= 400 ? `HTTP ${status}, ` : ""}no Lever application form at ${page.url()}` };
  },

  async root(page): Promise<Page | Frame> {
    return page;
  },

  async readFields(page) {
    const fields = await extractFields(page, FORM);
    const facts = (await page.evaluate(inPage(fieldFacts), fields.map(f => f.id))) as Record<string, FieldFacts>;
    return fields.map(f => {
      // select2 university pickers list thousands of options: like Greenhouse's async selects, answer by text.
      const base: FieldSpec = f.kind === "combobox" ? { ...f, options: undefined } : f;
      if (base.options === undefined) delete base.options;
      const x = facts[f.id];
      if (!x?.label) return base;
      // A lone checkbox is its own question (its option text); the surrounding label belongs to a sibling group.
      if (base.kind === "checkbox") return { ...base, label: base.label.replace(/\s*[*✱]+\s*$/, "").trim(), required: base.required || x.required };
      return { ...base, label: x.label, required: base.required || x.required };
    });
  },

  async fill(page, field, answer) {
    if (field.kind === "combobox") return pickSelect2(page, field, answer);
    await fillField(page, field, answer);
  },

  async readOptions(page, field, typed, search) {
    if (field.kind !== "combobox") return readOptionsField(page, field, typed, search);
    return listSelect2(page, field, typed, search);
  },

  async afterUpload(page) {
    // Lever shows "Analyzing resume..." while its parser runs, then writes what it parsed into the form. Wait for it to
    // start (or for a parse result), then for the indicator to go away. A parse that never ends only costs the wait:
    // the runner verifies (and re-fills) every value afterwards.
    const deadline = Date.now() + PARSE_WAIT_MS;
    await page.waitForFunction(inPage(resumeParse), "started", { timeout: PARSE_START_MS, polling: 100 }).catch(() => {});
    await page.waitForFunction(inPage(resumeParse), "settled", { timeout: Math.max(1, deadline - Date.now()), polling: 200 }).catch(() => {});
    await page.waitForTimeout(PARSE_SETTLE_MS).catch(() => {});
  },

  async readBack(page, field) {
    if (field.kind === "combobox") {
      // select2 keeps the real value in the hidden <select> next to the widget.
      const picked = (await page.locator(`[data-aa-id="${field.id}"]`).first().evaluate(inPage((e: Element) => {
        const select = e.closest(".application-field")?.querySelector("select");
        return select ? (select.value === "" ? null : (select.selectedOptions[0]?.textContent ?? "").trim()) : undefined;
      }))) as string | null | undefined;
      if (picked !== undefined) return picked;
    }
    return readBackField(page, field);
  },

  async submit(page) {
    await page.locator("#btn-submit").or(page.getByRole("button", { name: /submit application/i })).first().click();
  },

  async outcome(page): Promise<SubmitOutcome> {
    if (endsWith(page.url(), "thanks")) return { kind: "submitted" };
    const s = (await page.evaluate(inPage(pageState), FORM)) as PageState;
    if (s.thanks) return { kind: "submitted" };
    if (s.captcha) return { kind: "captcha" };
    if (s.errors.length) return { kind: "validation-error", messages: s.errors };
    return { kind: "pending" };
  },

  async description(page) {
    // The apply page carries only the posting header; the description lives on the posting page itself.
    const box = page.locator(".posting-page .content, [data-qa='posting-description']").first();
    if (!(await box.isVisible().catch(() => false))) return undefined;
    const text = (await box.innerText()).trim().slice(0, DESCRIPTION_MAX).trim();
    return text || undefined;
  },
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Picks an option in a select2 widget (Lever's university question): types into its search box, then clicks the result
 * equal to the answer, else the only result starting with it. Results are read from the listbox the widget owns
 * (aria-owns); several prefix matches are ambiguous and fail rather than guess.
 */
async function pickSelect2(page: Page, field: FieldSpec, answer: FieldAnswer): Promise<void> {
  if (answer.type !== "option" && answer.type !== "text") throw new Error(`combobox needs an option or text answer`);
  const typed = answer.type === "option" ? answer.option : answer.text;
  const want = norm(typed);
  const box = page.locator(`[data-aa-id="${field.id}"]`).first();
  await box.click();
  const search = page.locator(".select2-search__field:visible").first();
  await search.waitFor({ state: "visible", timeout: 5000 });
  await search.fill(typed);
  const owns = await box.getAttribute("aria-owns");
  const items = ".select2-results__option:not(.select2-results__message)";
  const options = owns ? page.locator(`[id=${JSON.stringify(owns)}] ${items}`) : page.locator(`.select2-container--open ${items}`);
  let seen: string[] = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    seen = (await options.allInnerTexts()).map(norm);
    const exact = seen.indexOf(want);
    if (exact >= 0) return options.nth(exact).click();
    const prefixed = seen.flatMap((t, i) => (t.startsWith(want) ? [i] : []));
    if (prefixed.length === 1) return options.nth(prefixed[0]).click();
    if (prefixed.length > 1) {
      await search.press("Escape").catch(() => {});
      throw new Error(`Ambiguous option "${typed}" for "${field.label}": ${prefixed.slice(0, 6).map(i => seen[i]).join(" | ")}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  await search.press("Escape").catch(() => {});
  throw new Error(`No option matching "${typed}" for "${field.label}" (saw: ${seen.slice(0, 10).join(" | ")})`);
}

const SELECT2_ITEMS = ".select2-results__option:not(.select2-results__message):not(.loading-results)";

/**
 * The option texts of a select2 widget, read from the results it owns: with the search box cleared (the whole list), or,
 * when that shows nothing, after typing the first letter of `typed`; with `search`, after typing all of `typed`. Waits
 * for an ajax search to settle; leaves the widget closed and its search box empty.
 */
async function listSelect2(page: Page, field: FieldSpec, typed?: string, search = false): Promise<string[]> {
  const box = page.locator(`[data-aa-id="${field.id}"]`).first();
  await box.click();
  const input = page.locator(".select2-search__field:visible").first();
  await input.waitFor({ state: "visible", timeout: 5000 });
  const owns = await box.getAttribute("aria-owns");
  const results = owns ? page.locator(`[id=${JSON.stringify(owns)}]`) : page.locator(".select2-container--open .select2-results__options");
  const read = async (waitMs: number) => {
    const deadline = Date.now() + waitMs;
    await new Promise(r => setTimeout(r, 300)); // let an ajax search start before reading
    for (;;) {
      const loading = await results.locator(".loading-results, .select2-results__option--load-more").count().catch(() => 0);
      const texts = (await results.locator(SELECT2_ITEMS).allInnerTexts().catch(() => [] as string[]))
        .map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean);
      if ((texts.length && !loading) || Date.now() >= deadline) return [...new Set(texts)];
      await new Promise(r => setTimeout(r, 200));
    }
  };
  try {
    const query = typed?.trim() ?? "";
    if (search && query) {
      await input.fill(query);
      return await read(5000);
    }
    await input.fill("");
    let texts = await read(1500);
    if (!texts.length && query) {
      await input.fill(query.slice(0, 1));
      texts = await read(5000);
    }
    return texts;
  } finally {
    await input.fill("").catch(() => {});
    await input.press("Escape").catch(() => {});
  }
}

type FieldFacts = { label: string; required: boolean };

// Runs inside the page: must be self-contained. "started": the parser is running or has produced a result;
// "settled": the "Analyzing resume" indicator is not showing.
function resumeParse(phase: "started" | "settled"): boolean {
  const shown = (sel: string) => Array.from(document.querySelectorAll(sel))
    .some(e => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0);
  const working = shown(".resume-upload-working");
  if (phase === "settled") return !working;
  const stored = (document.querySelector('input[name="resumeStorageId"]') as HTMLInputElement | null)?.value ?? "";
  return working || stored !== "" || shown(".resume-upload-success, .resume-upload-failure");
}

// Runs inside the page: must be self-contained.
function fieldFacts(ids: string[]): Record<string, FieldFacts> {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const out: Record<string, FieldFacts> = {};
  for (const id of ids) {
    const el = document.querySelector(`[data-aa-id="${id}"]`);
    const label = el?.closest(".application-question")?.querySelector(".application-label");
    if (!label) continue;
    const clone = label.cloneNode(true) as Element;
    const required = !!clone.querySelector(".required");
    clone.querySelectorAll(".required, a, svg, button, input, select, textarea").forEach(n => n.remove());
    out[id] = { label: squash(clone.textContent), required };
  }
  return out;
}

type PageState = { thanks: boolean; captcha: boolean; errors: string[] };

// Runs inside the page: must be self-contained.
function pageState(formSelector: string): PageState {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
  // A thank-you only counts once the form is gone, and never from the posting header/description, the footer or the form.
  const formVisible = Array.from(document.querySelectorAll(formSelector)).some(visible);
  let thanks = false;
  if (!formVisible && document.body) {
    const parts: string[] = [];
    const skip = `script, style, .posting-header, .posting-page .content, [data-qa='posting-description'], .main-footer, ${formSelector}`;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest(skip) || !visible(parent)) continue;
      parts.push(n.textContent ?? "");
    }
    thanks = /application (has been )?(submitted|received)|thanks? (you )?for applying/i.test(squash(parts.join(" ")));
  }
  const captcha = Array.from(document.querySelectorAll('iframe[src*="hcaptcha"][title*="challenge" i]'))
    .some(e => visible(e) && !/checkbox/i.test(e.getAttribute("title") ?? "") && !/frame=checkbox/.test(e.getAttribute("src") ?? ""));
  const errors: string[] = [];
  const add = (msg: string) => { if (msg && !errors.includes(msg)) errors.push(msg); };
  for (const e of Array.from(document.querySelectorAll(".error-message"))) {
    if (visible(e)) add(squash((e as HTMLElement).innerText));
  }
  for (const e of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
    if (!visible(e)) continue;
    const q = e.closest(".application-question");
    if (q && Array.from(q.querySelectorAll(".error-message")).some(visible)) continue; // already reported
    const label = squash(q?.querySelector(".application-label")?.textContent).replace(/\s*[*✱]+\s*$/, "");
    add(label ? `${label}: invalid` : "invalid field");
  }
  return { thanks, captcha, errors };
}
