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
 *   whose own label is just "Attach"; after upload the input is replaced by `.file-upload__filename`.
 * - errors: `p#<id>-error.helper-text--error` (field label at `#<id>-label` or `#upload-label-<id>`).
 * - email check after a suspicious submit: `fieldset#email-verification` with `input#security-input-0..7`.
 * - reCAPTCHA Enterprise is invisible (`iframe[src*=recaptcha][size=invisible]` anchor); a challenge is the bframe
 *   `iframe[title*=challenge]`.
 * - closed posting: redirect to `/<board>?error=true` "The job you are looking for is no longer open."
 * - description: `.job__description` (absent on the bare /embed/job_app page).
 */
import type { Frame, Locator, Page } from "playwright";
import { extractFields } from "../forms/extract.js";
import { fillField, readBack as readBackField } from "../forms/fill.js";
import { inPage } from "../forms/in-page.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "./types.js";

const HOSTS = new Set(["job-boards.greenhouse.io", "boards.greenhouse.io", "job-boards.eu.greenhouse.io"]);
const FORM = "#application-form, form#application_form";
const ASYNC_SELECT = /^((school|degree|discipline)--\d+|candidate-location)$/;
const DESCRIPTION_MAX = 8000;

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
    if (resp && resp.status() === 404) return { ok: false, reason: "not-found", detail: `HTTP 404 at ${page.url()}` };
    const root = await greenhouse.root(page);
    const form = root.locator(FORM).first();
    if (!(await form.isVisible())) {
      // A name starting with "apply" (never "submit application") reveals a hidden form.
      const reveal = root.getByRole("link", { name: /^\s*apply/i }).or(root.getByRole("button", { name: /^\s*apply/i }))
        .filter({ hasNotText: /submit/i }).first();
      if (await reveal.isVisible().catch(() => false)) {
        await reveal.click();
        await form.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      }
    }
    if (await form.isVisible()) return { ok: true };
    const text = await page.locator("body").innerText().catch(() => "");
    if (/no longer (open|available|accepting)/i.test(text)) return { ok: false, reason: "closed", detail: "job is no longer open" };
    if (resp && resp.status() >= 400) return { ok: false, reason: "not-found", detail: `HTTP ${resp.status()} at ${page.url()}` };
    return { ok: false, reason: "closed", detail: "no application form" };
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
    if ([page.url(), root.url()].some(u => u.includes("confirmation"))) return { kind: "submitted" };
    const s = (await root.evaluate(inPage(pageState))) as PageState;
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
 * Picks a react-select option: types `want` (filters static lists, triggers async search), then clicks the first
 * option equal to it, else the first starting with it. Waits for async results instead of trusting the first list.
 */
async function pickOption(root: Page | Frame, field: FieldSpec, answer: FieldAnswer): Promise<void> {
  if (answer.type !== "option" && answer.type !== "text") throw new Error(`combobox needs an option or text answer`);
  const want = norm(answer.type === "option" ? answer.option : answer.text);
  const input = byId(root, field);
  const shell = root.locator(".select-shell", { has: input });
  await input.click();
  await input.fill(answer.type === "option" ? answer.option : answer.text).catch(() => {});
  const scoped = shell.locator("[role=option]");
  const loading = shell.locator('[class*="loading"]');
  let seen: string[] = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const options: Locator = (await scoped.count()) ? scoped : root.locator("[role=option]:visible");
    seen = (await options.allInnerTexts()).map(norm);
    let idx = seen.indexOf(want);
    if (idx < 0 && !(await loading.count())) idx = seen.findIndex(t => t.startsWith(want));
    if (idx >= 0) {
      await options.nth(idx).click();
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  await input.press("Escape").catch(() => {});
  throw new Error(`No option matching "${want}" for "${field.label}" (saw: ${seen.slice(0, 10).join(" | ")})`);
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
function pageState(): PageState {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
  const text = document.body?.innerText ?? "";
  const thanks = /thank you for applying|application (has been )?(submitted|received)/i.test(text);
  const captcha = Array.from(document.querySelectorAll('iframe[src*="recaptcha"][title*="challenge"], iframe[src*="hcaptcha"][title*="challenge"]')).some(visible);
  const code = /security code|verification code/i.test(text) &&
    Array.from(document.querySelectorAll("input")).some(i => !["hidden", "submit", "button"].includes(i.type) && visible(i));
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
