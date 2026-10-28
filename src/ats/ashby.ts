/**
 * Ashby handler. Selectors confirmed against live jobs.ashbyhq.com pages (Oct 2026; Hiya, 42dot, Skydio, Niantic Spatial,
 * Normal Computing). Ashby is a React SPA with stable `ashby-*` class names (hashed `_x_hash` classes are NOT stable):
 * - the application form lives at `<posting>/application` inside `div#form` (there is NO <form> element). The fields are
 *   in `div.ashby-application-form-container`. Some postings (Skydio) add a SECOND container inside
 *   `.ashby-survey-form-container` (EEO radios/selects, entries are plain `div[data-field-path]` with a `fieldset` radio-group),
 *   so fields are read from `#form`. `#form` also holds the "Autofill from resume" widget (class containing
 *   `ashby-application-form-autofill`, with its own file input): those controls are dropped. Never use it.
 * - the job description is NOT in the DOM on `/application`; it lives on the Overview tab
 *   (`#overview.ashby-job-posting-description-container` > `.ashby-job-posting-description`).
 * - each question is `div.ashby-application-form-field-entry[data-field-path]` > `label.ashby-application-form-question-title`
 *   (for=input id; a required question has a hashed class containing `_required_`; the `required` attribute is only set
 *   on text-like inputs) + optional `.ashby-application-form-question-description` + the control.
 * - controls: `input.ashby-application-form-input-text` (type text/email/tel/url), `textarea.ashby-application-form-input-textarea`,
 *   `input[type=file]` inside `.ashby-application-form-input-file` (resume `#_systemfield_resume`, optional cover_letter),
 *   native radios/checkbox groups (`.ashby-application-form-input-radio-group`, `...-checkbox-group`), dropdown selects.
 * - Yes/No: `div.ashby-application-form-input-yesno` > two `button.ashby-application-form-input-yesno-option[data-option=yes|no]`
 *   plus a visually hidden `input[type=checkbox]`. Selected state is `aria-pressed="true"` (also a hashed `_active_` class).
 *   Clicking the pressed button again UNSELECTS it, so fill only clicks when the button is not already pressed.
 * - location / country: typeahead `input.ashby-application-form-input-autocomplete[role=combobox]` (no id, no options until typed;
 *   `aria-controls` appears while open) -> `div[role=listbox]` > `div[role=option].ashby-application-form-input-autocomplete-popup-result`
 *   with long names ("London, Greater London, England, United Kingdom"). The input value becomes the full name once picked.
 * - Hiya also has a texting-consent radio pair (`input[type=radio][name=communicationConsent]`) inside the phone field entry.
 * - submit: `button.ashby-application-form-submit-button` "Submit Application" (reCAPTCHA is invisible).
 * - results (read from Ashby's front-end bundle; a real submit is never clicked, so these are not observed live):
 *   success -> `.ashby-application-form-success-container` ("Your application was successfully submitted ...", role=status);
 *   field errors -> `[role=alert]` titled "Your form needs corrections" with `ul > li > p` messages;
 *   failure -> `.ashby-application-form-failure-container` / `.ashby-application-form-blocked-application-container`
 *   ("We couldn't submit your application" + message, e.g. flagged as spam). No URL change is relied on.
 * - a closed posting renders a "job not found" page instead of the tabs/form.
 */
import type { Frame, Locator, Page } from "playwright";
import { extractFields } from "../forms/extract.js";
import { fillField, readBack as readBackField } from "../forms/fill.js";
import { inPage } from "../forms/in-page.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "./types.js";

const HOST = "jobs.ashbyhq.com";
const FORM = ".ashby-application-form-container";
/** Holds the main form AND the survey (EEO) form that Ashby renders as a second container, plus the autofill widget. */
const SCOPE = "#form";
const AUTOFILL = '[class*="ashby-application-form-autofill"]'; // -pane / -uploader / -input-* depending on the page
const CONSENT = ".ashby-application-form-texting-consent-description";
const BOT_WALL = /just a moment|security check to continue|verify (that )?you are (a )?human|access denied|attention required/i;
const CLOSED = /job (you requested )?(was |is )?not found|no longer (open|available|accepting)|(job|position|posting) (has been )?(closed|filled)/i;
const DESCRIPTION_MAX = 8000;

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/** `https://jobs.ashbyhq.com/<org>/<id>[/overview][?q]` -> `.../application[?q]`; null when the URL is not a posting. */
function applicationUrl(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  u.pathname = `/${parts.slice(0, 2).join("/")}/application`;
  return u.toString();
}

export const ashby: AtsHandler = {
  name: "ashby",

  matches(url) {
    return parse(url)?.hostname === HOST;
  },

  async open(page, url): Promise<OpenResult> {
    const target = applicationUrl(url);
    if (!target) return { ok: false, reason: "not-found", detail: `not an Ashby posting URL: ${url}` };
    const resp = await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const status = resp?.status() ?? 0;
    if (status === 404) return { ok: false, reason: "closed", detail: `HTTP 404 at ${page.url()} (posting closed or removed)` };
    // The SPA renders the form after its API call: poll for it, stopping early on a closed page or a bot wall.
    let text = "";
    const deadline = Date.now() + 8000;
    for (;;) {
      if (await page.locator(FORM).first().isVisible().catch(() => false)) return { ok: true };
      text = await page.locator("body").innerText().catch(() => "");
      if (CLOSED.test(text) || status === 403 || status === 429 || BOT_WALL.test(`${await page.title().catch(() => "")}\n${text}`) || Date.now() > deadline) break;
      await page.waitForTimeout(250);
    }
    if (status === 403 || status === 429 || BOT_WALL.test(`${await page.title().catch(() => "")}\n${text}`)) {
      return { ok: false, reason: "blocked", detail: `bot wall (HTTP ${status}) at ${page.url()}` };
    }
    if (CLOSED.test(text)) return { ok: false, reason: "closed", detail: "job is no longer accepting applications" };
    return { ok: false, reason: "blocked", detail: `${status >= 400 ? `HTTP ${status}, ` : ""}no Ashby application form at ${page.url()}` };
  },

  async root(page): Promise<Page | Frame> {
    return page;
  },

  async readFields(page) {
    const fields = await extractFields(page, SCOPE);
    const facts = (await page.evaluate(inPage(fieldFacts), { ids: fields.map(f => f.id), scope: SCOPE, autofill: AUTOFILL, consent: CONSENT })) as Facts;
    const byId = new Map<string, FieldSpec>();
    for (const f of fields) {
      const x = facts.labels[f.id];
      byId.set(f.id, x ? { ...f, ...(x.label ? { label: x.label } : {}), required: f.required || x.required } : f);
    }
    for (const y of facts.yesNo) {
      byId.set(y.id, { id: y.id, label: y.label, kind: "radio", required: y.required, options: ["Yes", "No"], ...(y.description ? { description: y.description } : {}) });
    }
    return facts.order.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []));
  },

  async fill(page, field, answer) {
    if (await isYesNo(page, field)) return fillYesNo(page, field, answer);
    if (field.kind === "combobox") return pickOption(page, field, answer);
    await fillField(page, field, answer);
  },

  async readBack(page, field) {
    if (await isYesNo(page, field)) {
      return (await box(page, field).evaluate(inPage((e: Element) => {
        const pressed = Array.from(e.querySelectorAll("button")).find(b => b.getAttribute("aria-pressed") === "true");
        return pressed ? (pressed.textContent ?? "").trim() : null;
      }))) as string | null;
    }
    if (field.kind === "combobox") {
      // Only a value that came from picking an option counts (see pickOption); text merely typed reads as empty.
      return (await box(page, field).evaluate(inPage((e: HTMLInputElement) => {
        const picked = e.getAttribute("data-aa-picked");
        return picked !== null && picked === e.value && e.value !== "" ? e.value : null;
      }))) as string | null;
    }
    return readBackField(page, field);
  },

  async submit(page) {
    await page.locator(".ashby-application-form-submit-button").or(page.getByRole("button", { name: /submit application/i })).first().click();
  },

  async outcome(page): Promise<SubmitOutcome> {
    const s = (await page.evaluate(inPage(pageState), FORM)) as PageState;
    if (s.success) return { kind: "submitted" };
    if (s.captcha) return { kind: "captcha" };
    if (s.errors.length) return { kind: "validation-error", messages: s.errors };
    if (s.failure) return { kind: "unknown", detail: s.failure };
    return { kind: "pending" };
  },

  async description(page) {
    // Only the Overview tab carries the description; the /application route does not render it.
    const el = page.locator(".ashby-job-posting-description").first();
    if (!(await el.isVisible().catch(() => false))) return undefined;
    const text = (await el.innerText()).trim().slice(0, DESCRIPTION_MAX).trim();
    return text || undefined;
  },
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const box = (page: Page, field: FieldSpec): Locator => page.locator(`[data-aa-id="${field.id}"]`).first();
/** A Yes/No button pair (not a native Yes/No radio group): its tagged element is the container, not an <input>. */
async function isYesNo(page: Page, f: FieldSpec): Promise<boolean> {
  if (f.kind !== "radio" || f.options?.length !== 2 || f.options[0] !== "Yes" || f.options[1] !== "No") return false;
  return (await box(page, f).evaluate(inPage((e: Element) => e.tagName !== "INPUT"))) as boolean;
}

/** Clicks the Yes/No button matching the answer, unless it is already pressed (a second click would unselect it). */
async function fillYesNo(page: Page, field: FieldSpec, answer: FieldAnswer): Promise<void> {
  if (answer.type !== "option") throw new Error(`yes/no needs an option answer`);
  const want = norm(answer.option);
  if (want !== "yes" && want !== "no") throw new Error(`No option "${answer.option}" among: Yes, No`);
  const button = box(page, field).locator("button").filter({ hasText: new RegExp(`^\\s*${want}\\s*$`, "i") });
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
}

/**
 * Picks an option in Ashby's location typeahead: types the answer, then clicks the result equal to it, else the only
 * result starting with it. Results are read from the listbox the input controls (aria-controls); several prefix matches
 * are ambiguous and fail rather than guess ("London" vs "London, Ontario").
 */
async function pickOption(page: Page, field: FieldSpec, answer: FieldAnswer): Promise<void> {
  if (answer.type !== "option" && answer.type !== "text") throw new Error(`combobox needs an option or text answer`);
  const typed = answer.type === "option" ? answer.option : answer.text;
  const want = norm(typed);
  const input = box(page, field);
  await input.evaluate(inPage((e: Element) => e.removeAttribute("data-aa-picked")));
  await input.click();
  await input.fill("");
  await input.pressSequentially(typed);
  // Typed text alone is not an answer: remember the value of the picked option so readBack can tell the two apart.
  const pick = async (options: Locator, i: number) => {
    await options.nth(i).click();
    await input.evaluate(inPage(async (e: HTMLInputElement) => {
      await new Promise(r => setTimeout(r, 150));
      e.setAttribute("data-aa-picked", e.value);
    }));
  };
  const giveUp = async (message: string): Promise<never> => {
    await input.press("Escape").catch(() => {});
    await input.fill("").catch(() => {});
    throw new Error(message);
  };
  let seen: string[] = [];
  let stable = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const controls = (await input.getAttribute("aria-controls"))?.split(/\s+/)[0];
    const options = controls ? page.locator(`[id=${JSON.stringify(controls)}] [role=option]`) : null;
    seen = options ? (await options.allInnerTexts()).map(norm) : [];
    const exact = seen.indexOf(want);
    if (options && exact >= 0) return pick(options, exact);
    const prefixed = seen.flatMap((t, i) => (t.startsWith(want) ? [i] : []));
    const key = seen.join("\n");
    if (key !== stable) { stable = key; stableSince = Date.now(); }
    const settled = Date.now() - stableSince > 800;
    if (options && settled && prefixed.length === 1) return pick(options, prefixed[0]);
    if (prefixed.length > 1 && Date.now() - stableSince > 1500) {
      return giveUp(`Ambiguous option "${typed}" for "${field.label}": ${prefixed.slice(0, 6).map(i => seen[i]).join(" | ")}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return giveUp(`No option matching "${typed}" for "${field.label}" (saw: ${seen.slice(0, 10).join(" | ")})`);
}

type Facts = {
  labels: Record<string, { label: string; required: boolean }>;
  yesNo: { id: string; label: string; required: boolean; description?: string }[];
  order: string[];
};

// Runs inside the page: must be self-contained. Cleans question labels/required flags, finds the Yes/No button pairs
// (tagging their container with data-aa-id) and returns every field id in document order.
function fieldFacts(arg: { ids: string[]; scope: string; autofill: string; consent: string }): Facts {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const scopeEl = document.querySelector(arg.scope);
  const labels: Facts["labels"] = {};
  const yesNo: Facts["yesNo"] = [];
  if (!scopeEl) return { labels, yesNo, order: [] };
  const entryOf = (el: Element) => el.closest(".ashby-application-form-field-entry, [data-field-path]");
  const titleOf = (entry: Element | null) => entry?.querySelector(".ashby-application-form-question-title") ?? null;
  const isRequired = (t: Element | null) => !!t && /(^|\s)_required_/.test(t.getAttribute("class") ?? "");
  const cleanTitle = (t: Element) => squash(t.textContent).replace(/\s*[*✱]+\s*$/, "");

  const elements: { id: string; el: Element }[] = [];
  for (const id of arg.ids) {
    const el = document.querySelector(`[data-aa-id="${id}"]`);
    if (!el || el.closest(arg.autofill)) continue; // the "Autofill from resume" widget is never a field
    elements.push({ id, el });
    const entry = entryOf(el);
    const title = titleOf(entry);
    if (!entry || !title) continue;
    // An entry may hold several controls (Hiya: phone + consent radios): the consent radios are named by their explanation.
    const own = !el.closest(arg.consent);
    if (own) labels[id] = { label: cleanTitle(title), required: isRequired(title) };
    else {
      // e.g. Hiya's texting-consent radios inside the phone entry: name the question by the first sentence of its explanation.
      const consent = el.closest(arg.consent)?.querySelector("p");
      const first = /^.*?[.!?](\s|$)/.exec(squash(consent?.textContent))?.[0];
      if (first) labels[id] = { label: first.trim(), required: false };
    }
  }

  let counter = 0;
  document.querySelectorAll("[data-aa-id]").forEach(e => {
    const n = Number(/^f(\d+)$/.exec(e.getAttribute("data-aa-id") ?? "")?.[1]);
    if (n > counter) counter = n;
  });
  const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
  const seenParents = new Set<Element>();
  for (const b of Array.from(scopeEl.querySelectorAll("button"))) {
    const parent = b.parentElement;
    if (!parent || seenParents.has(parent) || !visible(parent)) continue;
    seenParents.add(parent);
    const buttons = Array.from(parent.children).filter(c => c.tagName === "BUTTON");
    const texts = buttons.map(c => squash(c.textContent).toLowerCase());
    if (buttons.length !== 2 || texts[0] !== "yes" || texts[1] !== "no") continue;
    const entry = entryOf(parent);
    const title = titleOf(entry);
    if (!title) continue;
    const id = parent.getAttribute("data-aa-id") ?? `f${++counter}`;
    parent.setAttribute("data-aa-id", id);
    const description = squash(entry?.querySelector(".ashby-application-form-question-description")?.textContent);
    yesNo.push({ id, label: cleanTitle(title), required: isRequired(title), ...(description ? { description } : {}) });
    elements.push({ id, el: parent });
  }
  elements.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return { labels, yesNo, order: elements.map(e => e.id) };
}

type PageState = { success: boolean; captcha: boolean; errors: string[]; failure: string };

// Runs inside the page: must be self-contained.
function pageState(formSelector: string): PageState {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
  const formVisible = Array.from(document.querySelectorAll(formSelector)).some(visible);
  // Ashby swaps the form for its success container; thank-you wording elsewhere (description, header, form) never counts.
  let success = !formVisible && Array.from(document.querySelectorAll(".ashby-application-form-success-container")).some(visible);
  if (!success && !formVisible && document.body) {
    const parts: string[] = [];
    const skip = `script, style, .ashby-job-posting-header, .ashby-job-posting-heading, .ashby-job-posting-left-pane, .ashby-job-posting-description-container, .ashby-application-form-failure-container, ${formSelector}`;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || parent.closest(skip) || !visible(parent)) continue;
      parts.push(n.textContent ?? "");
    }
    success = /thank you for applying|application (was |has been )?(successfully )?submitted/i.test(squash(parts.join(" ")));
  }
  const captcha = Array.from(document.querySelectorAll("iframe"))
    .some(e => visible(e) && (/recaptcha\/(api2|enterprise)\/bframe/.test(e.getAttribute("src") ?? "") || /hcaptcha/.test(e.getAttribute("src") ?? "") && /challenge/i.test(e.getAttribute("title") ?? "") && !/checkbox/i.test(e.getAttribute("title") ?? "")));
  const errors: string[] = [];
  const add = (msg: string) => { if (msg && !errors.includes(msg)) errors.push(msg); };
  for (const alert of Array.from(document.querySelectorAll('[role="alert"]'))) {
    if (!visible(alert) || !/needs corrections/i.test(alert.textContent ?? "")) continue;
    for (const li of Array.from(alert.querySelectorAll("li"))) add(squash(li.textContent));
  }
  for (const e of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
    if (!visible(e) || !e.closest(formSelector)) continue;
    const label = squash(e.closest(".ashby-application-form-field-entry")?.querySelector(".ashby-application-form-question-title")?.textContent).replace(/\s*[*✱]+\s*$/, "");
    if (label && errors.some(m => m.includes(label))) continue; // already reported
    add(label ? `${label}: invalid` : "invalid field");
  }
  let failure = "";
  for (const f of Array.from(document.querySelectorAll(".ashby-application-form-failure-container, .ashby-application-form-blocked-application-container"))) {
    if (visible(f)) { failure = squash((f as HTMLElement).innerText); break; }
  }
  return { success, captcha, errors, failure };
}
