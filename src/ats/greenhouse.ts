/**
 * Greenhouse handler. Selectors confirmed against live job-boards.greenhouse.io forms (Oct 2026; boards.greenhouse.io
 * and /embed/job_app URLs now redirect there, so the legacy `form#application_form` is kept only as a fallback):
 * - form: `form#application-form` (class `application--form`); submit: `button[type=submit]` "Submit application".
 * - text fields: `input#first_name` etc. with `label[for]` and `aria-required="true"`; phone is `input[type=tel]#phone`.
 * - selects are react-select: `.select-shell` > `input.select__input[role=combobox]`, options `[role=option]` in the
 *   menu; the picked value renders as `.select__single-value` (multi: `.select__multi-value__label`).
 *   An `aria-hidden` mirror `<input required>` follows each one (skipped by extractFields).
 * - async-search selects: education `#school--N`, `#degree--N`, `#discipline--N`, and `#candidate-location`.
 * - uploads: `[role=group][aria-labelledby=upload-label-<id>][aria-required]` > visually hidden `input[type=file]#<id>`
 *   whose own label is just "Attach"; after upload the input is replaced by `.file-upload__filename`. fill waits for
 *   that (uploadSettled). An upload does not parse the resume into the form (autofill is the separate "Autofill with
 *   MyGreenhouse" button, never used), so there is no afterUpload.
 * - errors: `p#<id>-error.helper-text--error` (field label at `#<id>-label` or `#upload-label-<id>`).
 * - email check after a suspicious submit: `fieldset#email-verification` with `input#security-input-0..7`.
 * - reCAPTCHA Enterprise is invisible (`iframe[src*=recaptcha][size=invisible]` anchor); a challenge is the bframe
 *   `iframe[title*=challenge]`.
 * - closed posting: redirect to `/<board>?error=true` "The job you are looking for is no longer open."
 * - description: `.job__description` (absent on the bare /embed/job_app page).
 */
import type { Frame, Locator, Page } from "playwright";
import { isLocationAnswer, locationQueries, pickLocation } from "../answers/adapt.js";
import { extractFields } from "../forms/extract.js";
import { fillField, readBack as readBackField, readOptions as readOptionsField } from "../forms/fill.js";
import { inPage } from "../forms/in-page.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "./types.js";

const HOSTS = new Set(["job-boards.greenhouse.io", "boards.greenhouse.io", "job-boards.eu.greenhouse.io"]);
const FORM = "#application-form, form#application_form";
const ASYNC_SELECT = /^((school|degree|discipline)--\d+|candidate-location)$/;
const DESCRIPTION_MAX = 8000;
const BOT_WALL = /just a moment|security check to continue|verify (that )?you are (a )?human|access denied|attention required/i;
const APPLY = /^\s*apply/i;

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

const isGreenhouseHost = (url: string) => /(^|\.)greenhouse\.io$/.test(parse(url)?.hostname ?? "");
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const byId = (root: Page | Frame, field: FieldSpec) => root.locator(`[data-aa-id="${field.id}"]`).first();

export const greenhouse: AtsHandler = {
  name: "greenhouse",

  matches(url) {
    const u = parse(url);
    return !!u && (HOSTS.has(u.hostname) || u.searchParams.has("gh_jid"));
  },

  async open(page, url): Promise<OpenResult> {
    let resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
    if (!isGreenhouseHost(page.url())) {
      const src = await embedSrc(page);
      if (src) {
        resp = await page.goto(src, { waitUntil: "domcontentloaded" });
        await settle(page);
      }
    }
    const status = resp?.status() ?? 0;
    if (status === 404) return { ok: false, reason: "not-found", detail: `HTTP 404 at ${page.url()}` };
    const root = await greenhouse.root(page);
    const form = root.locator(FORM).first();
    if (!(await form.isVisible()) && isGreenhouseHost(root.url())) {
      const reveal = await revealControl(root);
      if (reveal) {
        await reveal.click();
        await form.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      }
    }
    if (await form.isVisible()) return { ok: true };
    const text = await page.locator("body").innerText().catch(() => "");
    if (/no longer (open|available|accepting)/i.test(text)) return { ok: false, reason: "closed", detail: "job is no longer open" };
    if (status === 403 || status === 429 || BOT_WALL.test(`${await page.title().catch(() => "")}\n${text}`)) {
      return { ok: false, reason: "blocked", detail: `bot wall (HTTP ${status}) at ${page.url()}` };
    }
    if (isGreenhouseHost(url) && !isGreenhouseHost(page.url())) {
      // Greenhouse sends postings that are gone to the company's own careers page.
      return { ok: false, reason: "closed", detail: `posting redirected off Greenhouse to ${page.url()}` };
    }
    if (!isGreenhouseHost(page.url())) {
      return { ok: false, reason: "blocked", detail: `company page without a Greenhouse form (its own application form?) at ${page.url()}` };
    }
    return { ok: false, reason: "not-found", detail: `${status >= 400 ? `HTTP ${status}, ` : ""}no application form at ${page.url()}` };
  },

  async root(page): Promise<Page | Frame> {
    if (await page.locator(FORM).count()) return page;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || !isGreenhouseHost(frame.url())) continue;
      if (await frame.locator(FORM).count().catch(() => 0)) return frame;
    }
    return page;
  },

  async readFields(page) {
    const root = await greenhouse.root(page);
    const fields = await extractFields(root, FORM);
    const facts = (await root.evaluate(inPage(fieldFacts), fields.map(f => f.id))) as Record<string, FieldFacts>;
    return fields.map(f => {
      const x = facts[f.id];
      if (!x) return f;
      const out: FieldSpec = { ...f };
      if (f.kind === "file" && x.uploadLabel) {
        out.label = x.uploadLabel;
        out.required = f.required || x.uploadRequired;
      }
      if (f.kind === "combobox") {
        if (ASYNC_SELECT.test(x.elementId)) delete out.options;
        const description = x.placeholder ? out.description?.replace(x.placeholder, "").trim() : out.description;
        if (description) out.description = description;
        else delete out.description;
      }
      return out;
    });
  },

  async fill(page, field, answer) {
    const root = await greenhouse.root(page);
    if (field.kind === "combobox") return pickOption(root, field, answer);
    await fillField(root, field, answer);
    if (field.kind === "file") await uploadSettled(root, field);
  },

  async readOptions(page, field, typed, search) {
    const root = await greenhouse.root(page);
    if (field.kind !== "combobox") return readOptionsField(root, field, typed);
    return listOptions(root, field, typed, search);
  },

  async readBack(page, field) {
    const root = await greenhouse.root(page);
    if (field.kind === "file") {
      const shown = root.locator(`[data-aa-file="${field.id}"] .file-upload__filename`);
      if (await shown.count()) return (await shown.first().innerText()).trim() || null;
      if (!(await byId(root, field).count())) return null;
    }
    if (field.kind === "combobox") {
      const picked = (await byId(root, field).evaluate(inPage(selectedValue))) as string | string[] | null | undefined;
      if (picked !== undefined) return picked;
    }
    return readBackField(root, field);
  },

  async submit(page) {
    const root = await greenhouse.root(page);
    await root.getByRole("button", { name: /submit application/i }).first().click();
  },

  async outcome(page): Promise<SubmitOutcome> {
    const root = await greenhouse.root(page);
    if ([page.url(), root.url()].some(u => /\/confirmation(\/|$)/.test(parse(u)?.pathname ?? ""))) return { kind: "submitted" };
    const s = (await root.evaluate(inPage(pageState), FORM)) as PageState;
    if (s.thanks) return { kind: "submitted" };
    if (s.captcha) return { kind: "captcha" };
    if (s.code) return { kind: "verification-code" };
    if (s.errors.length) return { kind: "validation-error", messages: s.errors };
    return { kind: "pending" };
  },

  async description(page) {
    const root = await greenhouse.root(page);
    const box = root.locator(".job__description, #content").first();
    if (!(await box.isVisible().catch(() => false))) return undefined;
    const text = (await box.innerText()).trim().slice(0, DESCRIPTION_MAX).trim();
    return text || undefined;
  },
};

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

/** The src of an embedded Greenhouse application iframe on a company-hosted page, if any. */
async function embedSrc(page: Page): Promise<string | null> {
  const frames = page.locator('iframe[src*="greenhouse.io"]');
  await frames.first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
  const srcs = (await frames.evaluateAll(inPage((els: Element[]) => els.map(e => (e as HTMLIFrameElement).src)))) as string[];
  return srcs.find(s => s.includes("job_app")) ?? srcs[0] ?? null;
}

/**
 * The control that reveals a hidden form: a link or button named "Apply..." that cannot submit anything —
 * never a submit-type control and never a control inside a form.
 */
async function revealControl(root: Page | Frame): Promise<Locator | null> {
  const candidates = root.getByRole("link", { name: APPLY }).or(root.getByRole("button", { name: APPLY }));
  for (const c of await candidates.all()) {
    if (!(await c.isVisible().catch(() => false))) continue;
    const safe = (await c.evaluate(inPage((e: Element) =>
      !e.closest("form") && e.getAttribute("type") !== "submit" && !/submit/i.test(e.textContent ?? "")))) as boolean;
    if (safe) return c;
  }
  return null;
}

/**
 * Picks a react-select option: types the answer (filters static lists, triggers async search), then clicks the option
 * equal to it, else the only option starting with it. Options are read from the listbox the input controls. Several
 * prefix matches are ambiguous and fail rather than guess ("University of Michigan" vs "... - Dearborn").
 */
async function pickOption(root: Page | Frame, field: FieldSpec, answer: FieldAnswer): Promise<void> {
  if (answer.type !== "option" && answer.type !== "text") throw new Error(`combobox needs an option or text answer`);
  const typed = answer.type === "option" ? answer.option : answer.text;
  const want = norm(typed);
  const input = byId(root, field);
  const loading = root.locator(".select-shell", { has: input }).locator('[class*="loading"]');
  if (isLocationAnswer(field, typed)) return pickPlace(root, field, typed, input, loading);
  await input.click();
  await input.fill(typed).catch(() => {});
  let seen: string[] = [];
  let stable = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const options = await listboxOptions(root, input);
    seen = options ? (await options.allInnerTexts()).map(norm) : [];
    const exact = seen.indexOf(want);
    if (options && exact >= 0) return options.nth(exact).click();
    const prefixed = seen.flatMap((t, i) => (t.startsWith(want) ? [i] : []));
    const settled = !(await loading.count());
    if (options && settled && prefixed.length === 1) return options.nth(prefixed[0]).click();
    const key = seen.join("\n");
    if (key !== stable || !settled) { stable = key; stableSince = Date.now(); }
    if (prefixed.length > 1 && Date.now() - stableSince > 1500) {
      await input.press("Escape").catch(() => {});
      throw new Error(`Ambiguous option "${typed}" for "${field.label}": ${prefixed.map(i => seen[i]).join(" | ")}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  await input.press("Escape").catch(() => {});
  throw new Error(`No option matching "${typed}" for "${field.label}" (saw: ${seen.slice(0, 10).join(" | ")})`);
}

/**
 * Picks the applicant's place in a location select (the `#candidate-location` geocoder): searches the value, the city
 * alone and "City, ST", waits for each search's results to settle, and clicks only an option naming that city and
 * state (pickLocation: "Houston, Texas, United States", never "Houston County, Alabama" or "Other Cast, Bihar, India").
 * No such option → error (the field fails; a place is never guessed).
 */
async function pickPlace(root: Page | Frame, field: FieldSpec, typed: string, input: Locator, loading: Locator): Promise<void> {
  const seen: string[] = [];
  await input.click();
  for (const q of locationQueries(typed)) {
    await input.fill(q).catch(() => {});
    await new Promise(r => setTimeout(r, 300)); // let the search start before reading
    let texts: string[] = [];
    let stable = "";
    let stableSince = Date.now();
    const deadline = Date.now() + 6000;
    for (;;) {
      const options = await listboxOptions(root, input);
      texts = options ? (await options.allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim()) : [];
      const settled = !(await loading.count());
      const key = texts.join("\n");
      if (key !== stable || !settled) { stable = key; stableSince = Date.now(); }
      const pick = settled && texts.length ? pickLocation(typed, texts) : null;
      if (options && pick !== null) return options.nth(texts.indexOf(pick)).click();
      if ((settled && Date.now() - stableSince > (texts.length ? 800 : 1500)) || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 200));
    }
    seen.push(...texts.filter(t => t && !seen.includes(t)));
  }
  await input.fill("").catch(() => {});
  await input.press("Escape").catch(() => {});
  throw new Error(`No option matching "${typed}" for "${field.label}" (saw: ${seen.slice(0, 10).join(" | ")})`);
}

/**
 * The option texts of a react-select, read with its typed text cleared so a static list shows whole. An async search
 * list (school, degree, discipline) may show nothing until something is typed: then the first letter of `typed` is
 * typed and the options it loads are read. With `search`, the whole of `typed` is typed and the options it surfaces are
 * read. Waits for the loading indicator to clear; leaves the select closed and empty.
 */
async function listOptions(root: Page | Frame, field: FieldSpec, typed?: string, search = false): Promise<string[]> {
  const input = byId(root, field);
  const loading = root.locator(".select-shell", { has: input }).locator('[class*="loading"]');
  const read = async (waitMs: number) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const options = await listboxOptions(root, input);
      const texts = options ? (await options.allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean) : [];
      if ((texts.length && !(await loading.count())) || Date.now() >= deadline) return [...new Set(texts)];
      await new Promise(r => setTimeout(r, 200));
    }
  };
  try {
    await input.click();
    await input.fill("").catch(() => {});
    if (search && typed?.trim()) {
      await input.fill(typed.trim());
      await new Promise(r => setTimeout(r, 300)); // let an async search start before reading
      return await read(5000);
    }
    let texts = await read(2000);
    const hint = typed?.trim().slice(0, 1);
    if (!texts.length && hint) {
      await input.pressSequentially(hint);
      texts = await read(5000);
    }
    return texts;
  } finally {
    await input.fill("").catch(() => {});
    await input.press("Escape").catch(() => {});
  }
}

/** The options of the listbox named by the input's aria-controls; else of the only open listbox on the page. */
async function listboxOptions(root: Page | Frame, input: Locator): Promise<Locator | null> {
  const controls = (await input.getAttribute("aria-controls"))?.split(/\s+/)[0];
  if (controls) return root.locator(`[id=${JSON.stringify(controls)}] [role=option]`);
  const open = root.locator("[role=listbox]:visible");
  return (await open.count()) === 1 ? open.locator("[role=option]") : null;
}

/** Waits until Greenhouse shows the uploaded file name (or rejects the file) in place of the file input. */
async function uploadSettled(root: Page | Frame, field: FieldSpec): Promise<void> {
  const group = root.locator(`[data-aa-file="${field.id}"]`);
  if (!(await group.count())) return;
  const done = group.locator(".file-upload__filename, .helper-text--error").first();
  await done.waitFor({ state: "visible", timeout: 15000 });
  const error = group.locator(".helper-text--error");
  if (await error.count()) throw new Error(`Upload rejected for "${field.label}": ${(await error.first().innerText()).trim()}`);
}

type FieldFacts = { elementId: string; uploadLabel: string; uploadRequired: boolean; placeholder: string };

// Runs inside the page: must be self-contained.
function fieldFacts(ids: string[]): Record<string, FieldFacts> {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const out: Record<string, FieldFacts> = {};
  for (const id of ids) {
    const el = document.querySelector(`[data-aa-id="${id}"]`);
    if (!el) continue;
    const elementId = el.id;
    const group = el.matches("input[type=file]") ? el.closest("[role=group][aria-labelledby]") : null;
    let uploadLabel = "";
    if (group) {
      group.setAttribute("data-aa-file", id);
      const labelIds = (group.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      uploadLabel = squash(labelIds.map(i => document.getElementById(i)?.textContent ?? "").join(" ")).replace(/\s*\*+\s*$/, "");
    }
    const placeholder = elementId ? squash(document.getElementById(`react-select-${elementId}-placeholder`)?.textContent) : "";
    out[id] = { elementId, uploadLabel, uploadRequired: group?.getAttribute("aria-required") === "true", placeholder };
  }
  return out;
}

// Runs inside the page. undefined = not a react-select (fall back to the generic read).
function selectedValue(input: HTMLElement): string | string[] | null | undefined {
  const shell = input.closest(".select-shell, .select__container");
  if (!shell) return undefined;
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const multi = Array.from(shell.querySelectorAll(".select__multi-value__label")).map(e => squash(e.textContent)).filter(Boolean);
  if (multi.length) return multi;
  return squash(shell.querySelector(".select__single-value")?.textContent) || null;
}

type PageState = { thanks: boolean; captcha: boolean; code: boolean; errors: string[] };

// Runs inside the page: must be self-contained.
function pageState(formSelector: string): PageState {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
  // A thank-you only counts once the form is gone, and never from the job description (which often says
  // "thank you for applying") or the form itself.
  const formVisible = Array.from(document.querySelectorAll(formSelector)).some(visible);
  let thanks = false;
  if (!formVisible && document.body) {
    const parts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest(`.job__description, #content, script, style, ${formSelector}`) || !visible(parent)) continue;
      parts.push(n.textContent ?? "");
    }
    thanks = /thank you for applying|application (has been )?(submitted|received)/i.test(squash(parts.join(" ")));
  }
  const captcha = Array.from(document.querySelectorAll('iframe[src*="recaptcha"][title*="challenge"], iframe[src*="hcaptcha"][title*="challenge"]')).some(visible);
  // Greenhouse's email check: fieldset#email-verification with one input per code character.
  const code = Array.from(document.querySelectorAll('fieldset#email-verification input, input[id^="security-input-"]')).some(visible);
  const fieldLabel = (errorId: string) => {
    const base = /^(.*)-error$/.exec(errorId)?.[1];
    if (!base) return "";
    const label = document.getElementById(`${base}-label`) ?? document.getElementById(`upload-label-${base}`);
    return squash(label?.textContent).replace(/\s*\*+\s*$/, "");
  };
  const errors: string[] = [];
  for (const e of Array.from(document.querySelectorAll('[class*="error"], [aria-invalid="true"]'))) {
    if (!visible(e)) continue;
    // Labels and control wrappers also get "--error" classes; the message is the helper text.
    let msgEl: Element | null = e;
    if (e.matches("input, select, textarea, [role=combobox]")) msgEl = document.getElementById(e.getAttribute("aria-errormessage") ?? "");
    else if (e.matches('label, legend, [class*="label"]') || e.querySelector("input, select, textarea, button")) continue;
    if (!msgEl || !visible(msgEl)) continue;
    const msg = squash((msgEl as HTMLElement).innerText);
    if (!msg) continue;
    const label = fieldLabel(msgEl.id);
    const full = label ? `${label}: ${msg}` : msg;
    if (!errors.includes(full)) errors.push(full);
  }
  return { thanks, captcha, code, errors };
}
