/**
 * Filling the controls collectFields tagged (data-aa-id) from inside the page, in a way React and Vue forms accept:
 * values go through the element prototype's native setter followed by input/change/blur events (a framework that tracks
 * the value it last rendered then sees a real change); choices are clicked like a person would.
 */
import type { ExtAnswer } from "../../src/ext/protocol.js";
import type { FieldSpec } from "../../src/forms/types.js";

export type FillOutcome = { ok: true; value: FieldValue } | { ok: false; error: string };
export type FieldValue = string | string[] | boolean | null;
export interface FillDeps {
  /** The resume file for an upload, or null when the app has none. */
  resume(): Promise<File | null>;
  /** How long a combobox may take to show its options (ms). */
  optionWaitMs?: number;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const membersOf = (id: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-aa-id="${CSS.escape(id)}"]`));

function isVisible(e: Element): boolean {
  return e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
}

/** True for controls the extension must never write to. */
export function isForbidden(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === "password";
}

/** Sets `value` through the prototype's own setter, so a framework's per-node value tracker doesn't swallow the change. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));

function inputEvent(el: Element, data: string | null): void {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data }));
}

function focus(el: HTMLElement): void {
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function blur(el: HTMLElement): void {
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  el.dispatchEvent(new FocusEvent("blur"));
  if (document.activeElement === el) el.blur();
}

/** A real-looking click: pointer and mouse down/up, then click (react-select opens on mousedown). */
export function press(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

/** Types `text` into a text box as one edit: focus, native value, input, change, blur. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  focus(el);
  setNativeValue(el, text);
  inputEvent(el, text);
  fire(el, "change");
  blur(el);
}

/** The index of the option equal to `want`: exactly, then ignoring case and spacing. */
function findOption(opts: readonly string[], want: string): number {
  const exact = opts.indexOf(want);
  return exact >= 0 ? exact : opts.findIndex(o => norm(o) === norm(want));
}

const optLabel = (e: Element) => e.getAttribute("data-aa-opt") ?? "";

function answerText(a: ExtAnswer): string | null {
  return a.type === "text" ? a.text : a.type === "option" ? a.option : null;
}

/** Fills one field with the app's answer. Never touches password boxes and never throws. */
export async function fillField(field: FieldSpec, answer: ExtAnswer, deps: FillDeps): Promise<FillOutcome> {
  const members = membersOf(field.id);
  const el = members[0];
  if (!el) return { ok: false, error: "The field is gone from the page" };
  if (members.some(isForbidden)) return { ok: false, error: "Password fields are never filled" };
  try {
    switch (field.kind) {
      case "select": {
        const want = answerText(answer);
        if (want === null || !(el instanceof HTMLSelectElement)) return { ok: false, error: "A list needs one of its options" };
        const opts = Array.from(el.options);
        const i = findOption(opts.map(o => o.label.replace(/\s+/g, " ").trim()), want);
        const j = i >= 0 ? i : findOption(opts.map(o => (o.textContent ?? "").replace(/\s+/g, " ").trim()), want);
        if (j < 0) return { ok: false, error: `No option matching "${want}"` };
        focus(el);
        setNativeValue(el, opts[j]!.value);
        opts[j]!.selected = true;
        fire(el, "input");
        fire(el, "change");
        blur(el);
        break;
      }
      case "radio": {
        const want = answerText(answer);
        if (want === null) return { ok: false, error: "A choice needs one of its options" };
        const i = findOption(members.map(optLabel), want);
        if (i < 0) return { ok: false, error: `No option matching "${want}"` };
        const target = members[i] as HTMLInputElement;
        if (!target.checked) target.click();
        break;
      }
      case "checkbox": {
        const want = answer.type === "check" ? answer.checked : answer.type === "text" ? /^(yes|true|y)$/i.test(answer.text.trim()) : null;
        if (want === null || !(el instanceof HTMLInputElement)) return { ok: false, error: "A tick box needs yes or no" };
        if (el.checked !== want) el.click();
        break;
      }
      case "checkbox-group": {
        const wanted = answer.type === "options" ? answer.options : answer.type === "option" ? [answer.option] : null;
        if (!wanted) return { ok: false, error: "Tick boxes need a list of options" };
        const labels = members.map(optLabel);
        const idx = wanted.map(w => findOption(labels, w));
        if (idx.some(i => i < 0)) return { ok: false, error: `No option matching "${wanted[idx.findIndex(i => i < 0)]}"` };
        members.forEach((m, i) => {
          const box = m as HTMLInputElement;
          if (box.checked !== idx.includes(i)) box.click();
        });
        break;
      }
      case "file": {
        if (answer.type !== "file" || !(el instanceof HTMLInputElement)) return { ok: false, error: "Only the resume can be attached" };
        const file = await deps.resume();
        if (!file) return { ok: false, error: "No resume in the app's Profile" };
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        fire(el, "input");
        fire(el, "change");
        break;
      }
      case "combobox": {
        const want = answerText(answer);
        if (want === null) return { ok: false, error: "A list needs one of its options" };
        const picked = await pickCombobox(el, want, deps.optionWaitMs ?? 2500);
        if (!picked) return { ok: false, error: `No option matching "${want}"` };
        break;
      }
      default: {
        const text = answerText(answer);
        if (text === null || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { ok: false, error: "A text box needs text" };
        typeInto(el, el instanceof HTMLTextAreaElement ? text : text.replace(/\s*[\r\n]+\s*/g, " "));
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, value: readValue(field) };
}

/** The visible options a combobox shows (from the listbox it names, else anywhere on the page). */
function visibleOptions(box: HTMLElement): HTMLElement[] {
  const ids = [box, box.querySelector("input")].flatMap(e => (e?.getAttribute("aria-controls") ?? e?.getAttribute("aria-owns") ?? "").split(/\s+/)).filter(Boolean);
  for (const id of ids) {
    const list = document.getElementById(id);
    const opts = list ? Array.from(list.querySelectorAll<HTMLElement>("[role=option]")).filter(isVisible) : [];
    if (opts.length) return opts;
  }
  return Array.from(document.querySelectorAll<HTMLElement>("[role=option]")).filter(isVisible);
}

/**
 * Opens the combobox, types `want` (when it has a text box) and clicks the option equal to it, else the only option
 * starting with it. Nothing matching: the typed text is cleared and the list closed; returns false.
 */
async function pickCombobox(box: HTMLElement, want: string, waitMs: number): Promise<boolean> {
  const input = box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement ? box : box.querySelector<HTMLInputElement>("input");
  press(box);
  if (input) {
    focus(input);
    setNativeValue(input, want);
    inputEvent(input, want);
  }
  const target = norm(want);
  const end = Date.now() + waitMs;
  for (;;) {
    const opts = visibleOptions(box);
    const texts = opts.map(o => norm(o.textContent));
    let i = texts.indexOf(target);
    if (i < 0) {
      const starts = texts.flatMap((t, k) => (t.startsWith(target) ? [k] : []));
      if (starts.length === 1) i = starts[0]!;
    }
    if (i >= 0) {
      press(opts[i]!);
      await sleep(50);
      if (input) blur(input);
      return true;
    }
    if (Date.now() > end) break;
    await sleep(100);
  }
  if (input) {
    setNativeValue(input, "");
    inputEvent(input, null);
  }
  const esc = { key: "Escape", code: "Escape", bubbles: true };
  (input ?? box).dispatchEvent(new KeyboardEvent("keydown", esc));
  if (input) blur(input);
  return false;
}

/** What the field holds now (as the user would submit it). */
export function readValue(field: FieldSpec): FieldValue {
  const members = membersOf(field.id);
  const el = members[0];
  if (!el) return null;
  switch (field.kind) {
    case "select": {
      const s = el as HTMLSelectElement;
      return s.value === "" ? null : (s.selectedOptions[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    case "radio": {
      const on = members.find(m => (m as HTMLInputElement).checked);
      return on ? optLabel(on) : null;
    }
    case "checkbox":
      return (el as HTMLInputElement).checked;
    case "checkbox-group":
      return members.filter(m => (m as HTMLInputElement).checked).map(optLabel);
    case "file": {
      const names = Array.from((el as HTMLInputElement).files ?? []).map(f => f.name);
      return names.length === 0 ? null : names.length === 1 ? names[0]! : names;
    }
    case "combobox": {
      const input = el instanceof HTMLInputElement ? el : el.querySelector("input");
      if (input?.value) return input.value;
      const picked = selectedChips(el);
      if (picked.length) return picked.length === 1 ? picked[0]! : picked;
      return el instanceof HTMLInputElement ? "" : (el.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    default:
      return (el as HTMLInputElement).value;
  }
}

/** react-select style pickers show the picked value(s) beside an emptied search box. */
const CHIP = '[class*="singleValue" i], [class*="single-value" i], [class*="multiValue__label" i], [class*="multi-value__label" i]';

/** The values a select-like combobox shows as picked (from the nearest wrapper holding them, at most 4 levels up). */
function selectedChips(el: HTMLElement): string[] {
  for (let a: HTMLElement | null = el, d = 0; a && d < 5; a = a.parentElement, d++) {
    // Never a wrapper around another picker: its chips are that field's.
    if (a.querySelectorAll("[role=combobox]").length > 1) break;
    const chips = Array.from(a.querySelectorAll(CHIP)).map(c => (c.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (chips.length) return chips;
    if (a.matches("label, fieldset, form")) break;
  }
  return [];
}

/** Whether a value is empty (nothing typed, nothing picked). */
export const isEmpty = (v: FieldValue) => v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);

/** Whether two values are the same answer (ignoring case and spacing). */
export function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = (Array.isArray(a) ? a : a === null ? [] : [String(a)]).map(norm).sort();
    const y = (Array.isArray(b) ? b : b === null ? [] : [String(b)]).map(norm).sort();
    return x.join("\u0001") === y.join("\u0001");
  }
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return norm(a) === norm(b);
}
