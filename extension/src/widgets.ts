/**
 * Custom choice widgets, driven from inside the page the way the runner's Playwright handlers drive them
 * (ats/greenhouse.ts, lever.ts, ashby.ts): open the control, read the options of ITS list (aria-controls / aria-owns,
 * select2's open dropdown, the popup a listbox button opens), type searches into lazy or async lists and wait for their
 * results to settle, click the option with real pointer and mouse events (react-select acts on mousedown/click, select2
 * on mouseup), and check the value the control then shows.
 *
 * Kinds handled:
 * - react-select (Greenhouse): `input[role=combobox]` inside a `*__control` box; picked values render as
 *   `*__single-value` / `*__multi-value__label` chips; a loading indicator shows while an async search runs.
 * - select2 (Lever's university picker): `span.select2-selection[role=combobox][aria-owns]`; its search box and
 *   `li.select2-results__option` results live in a dropdown appended to <body>; the real value is the hidden <select>.
 * - listbox buttons (Workday's `button[aria-haspopup=listbox]`, any non-input `[role=combobox]`): no text box; the
 *   button opens a `[role=listbox]` popup; the button's text is the value.
 * - typeaheads (Ashby's location, SmartRecruiters' city, Workday's multiselect prompt): the input is the combobox.
 */
import { byIdNear, composedParent, deepQueryAll } from "./dom.js";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export const norm = (s: string | null | undefined) => squash(s).toLowerCase();

export function isVisible(e: Element): boolean {
  return e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;
}

// Every event is composed, so a web component listening on its host (outside the shadow root) hears it too.
export const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));

export function inputEvent(el: Element, data: string | null): void {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, cancelable: false, inputType: data === null ? "deleteContentBackward" : "insertText", data }));
}

export function key(el: Element, k: string, type: "keydown" | "keyup" = "keydown"): void {
  const code = k.length === 1 ? (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`) : k;
  const keyCode = ({ Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38, Tab: 9, Backspace: 8 } as Record<string, number>)[k] ?? k.toUpperCase().charCodeAt(0);
  el.dispatchEvent(new KeyboardEvent(type, { key: k, code, keyCode, which: keyCode, bubbles: true, composed: true, cancelable: true } as KeyboardEventInit));
}

export function focus(el: HTMLElement): void {
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
}

export function blur(el: HTMLElement): void {
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  el.dispatchEvent(new FocusEvent("blur", { composed: true }));
  if (el.matches(":focus")) el.blur();
}

/** Sets `value` through the prototype's own setter, so a framework's per-node value tracker doesn't swallow the change. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** A real-looking click: pointer and mouse down/up at the element's centre, then click (react-select opens on mousedown). */
export function press(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 12) };
  const opts = { bubbles: true, composed: true, cancelable: true, view: window, button: 0, buttons: 1, ...at };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  el.click();
}

type TextBox = HTMLInputElement | HTMLTextAreaElement;

/** Types `text` into a search box as a person's last keystroke would show it: the whole value, then input and keyup. */
export function typeSearch(input: TextBox, text: string): void {
  focus(input);
  const last = text.slice(-1) || "a";
  key(input, last);
  setNativeValue(input, text);
  inputEvent(input, text || null);
  key(input, last, "keyup");
}

const OPTION = '[role=option], [role=treeitem], li.select2-results__option';
const NOT_OPTION = '.select2-results__message, .loading-results, .select2-results__option--load-more, [role=group], [aria-disabled="true"]';
const LOADING = '[class*="loading" i], .loading-results, [aria-busy="true"]';
/** react-select style chips showing what is picked; Workday's multiselect pills. */
const CHIP = '[class*="singleValue" i], [class*="single-value" i], [class*="multiValue__label" i], [class*="multi-value__label" i], [data-automation-id="selectedItem"]';
/** A picker showing one of these shows no value. */
export const PLACEHOLDER = /^(select|choose|pick|start typing|search|type to search)\b.*|^-+$|^none selected$/i;

export type ComboKind = "react-select" | "select2" | "button" | "typeahead";

/** One custom choice control: how to open it, where to type, where its options are and what it shows as picked. */
export class Combo {
  readonly kind: ComboKind;
  /** The block holding the control and its own chips (never another picker's). */
  private shell: HTMLElement;

  constructor(readonly box: HTMLElement) {
    if (box.matches(".select2-selection, .select2-selection *") || box.closest(".select2-container")) this.kind = "select2";
    else if (!(box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) && !box.querySelector("input")) this.kind = "button";
    else if (controlBox(box)) this.kind = "react-select";
    else this.kind = "typeahead";
    this.shell = shellOf(box);
  }

  /** Where to type a search, if anywhere (select2's search box only exists while it is open). */
  input(): TextBox | null {
    const b = this.box;
    if (this.kind === "select2") {
      const container = b.closest(".select2-container");
      const inline = container?.querySelector<HTMLInputElement>(".select2-search__field");
      if (inline && isVisible(inline)) return inline;
      return deepQueryAll<HTMLInputElement>(document, ".select2-container--open .select2-search__field").find(isVisible) ?? null;
    }
    if (b instanceof HTMLInputElement || b instanceof HTMLTextAreaElement) return b;
    return b.querySelector<HTMLInputElement>("input:not([type=hidden])");
  }

  async open(): Promise<void> {
    const target = this.kind === "react-select" ? controlBox(this.box) ?? this.box : this.box;
    if (this.isOpen()) return;
    press(target);
    await sleep(60);
    if (!this.isOpen() && this.kind === "react-select") {
      // react-select also opens on ArrowDown in its input.
      const input = this.input();
      if (input) { focus(input); key(input, "ArrowDown"); await sleep(60); }
    }
  }

  isOpen(): boolean {
    if (this.kind === "select2") return !!this.box.closest(".select2-container--open") || deepQueryAll(document, ".select2-container--open .select2-results").some(isVisible);
    const expanded = [this.box, this.input()].some(e => e?.getAttribute("aria-expanded") === "true");
    return expanded || this.optionEls().length > 0;
  }

  /** The list this control owns, when it names one. */
  private lists(): HTMLElement[] {
    const ids = [this.box, this.input()].flatMap(e => [e?.getAttribute("aria-controls"), e?.getAttribute("aria-owns")])
      .flatMap(v => (v ?? "").split(/\s+/)).filter(Boolean);
    const out: HTMLElement[] = [];
    for (const id of new Set(ids)) {
      const l = byIdNear(this.box, id);
      if (l) out.push(l);
    }
    if (this.kind === "select2") out.push(...deepQueryAll(document, ".select2-container--open .select2-results__options"));
    return out;
  }

  /** The visible options of this control's list (its own list, else its shadow root's, else the one open popup). */
  optionEls(): HTMLElement[] {
    const clean = (els: HTMLElement[]) => els.filter(o => !o.matches(NOT_OPTION) && isVisible(o) && squash(o.textContent) !== "");
    for (const l of this.lists()) {
      const opts = clean(deepQueryAll(l, OPTION));
      if (opts.length) return opts;
    }
    const own = this.box.getRootNode();
    if (own instanceof ShadowRoot) {
      const opts = clean(deepQueryAll(own, OPTION));
      if (opts.length) return opts;
    }
    if (this.kind === "select2") return [];
    // A popup rendered elsewhere (Workday's listbox, a portal menu): the visible listbox nearest to the control.
    const boxes = deepQueryAll(document, "[role=listbox]").filter(l => isVisible(l) && !l.closest("#ai-applier-panel-host"));
    if (boxes.length) {
      const r = this.box.getBoundingClientRect();
      const dist = (l: Element) => { const q = l.getBoundingClientRect(); return Math.abs(q.top - r.bottom) + Math.abs(q.left - r.left) / 4; };
      const nearest = boxes.sort((a, b) => dist(a) - dist(b))[0]!;
      return clean(deepQueryAll(nearest, OPTION));
    }
    return [];
  }

  /** Whether the list is still loading (an async search running). */
  busy(): boolean {
    const scopes: Element[] = [this.shell, ...this.lists()];
    return scopes.some(s => deepQueryAll(s, LOADING).some(e => isVisible(e) && !e.matches(OPTION) && !e.querySelector(OPTION)));
  }

  /** Whether the control takes several values. */
  multi(): boolean {
    if (this.lists().some(l => l.getAttribute("aria-multiselectable") === "true")) return true;
    if (this.kind === "select2") return !!this.selectEl()?.multiple;
    return !!this.shell.querySelector('[class*="multi-value" i], [class*="multiValue" i], [data-automation-id="selectedItem"], [data-automation-id="multiselectInputContainer"]')
      || this.box.getAttribute("data-uxi-widget-type") === "selectinput";
  }

  /** select2's hidden <select> (the real value). */
  private selectEl(): HTMLSelectElement | null {
    const container = this.box.closest(".select2-container");
    const prev = container?.previousElementSibling;
    if (prev instanceof HTMLSelectElement) return prev;
    return this.shell.querySelector("select");
  }

  /** The value(s) the control shows as picked (empty when nothing is). */
  shown(): string[] {
    if (this.kind === "select2") {
      const sel = this.selectEl();
      if (sel) return Array.from(sel.selectedOptions).filter(o => o.value !== "").map(o => squash(o.textContent));
      const r = squash(this.box.querySelector(".select2-selection__rendered")?.textContent);
      return r && !PLACEHOLDER.test(r) ? [r] : [];
    }
    const chips = Array.from(this.shell.querySelectorAll(CHIP)).map(c => squash(c.textContent)).filter(Boolean);
    if (chips.length) return [...new Set(chips)];
    if (this.kind === "button") {
      const t = squash(this.box.textContent) || squash(this.box.getAttribute("value"));
      return t && !PLACEHOLDER.test(t) ? [t] : [];
    }
    const input = this.input();
    if (this.kind === "typeahead" && input?.value && !this.isOpen()) return [squash(input.value)];
    if (this.kind === "typeahead" && input?.value) return [squash(input.value)];
    return [];
  }

  /** Clears what was typed and closes the list. */
  close(clearTyped: boolean): void {
    const input = this.input();
    if (input && clearTyped && input.value) {
      setNativeValue(input, "");
      inputEvent(input, null);
    }
    const target = input ?? this.box;
    key(target, "Escape");
    key(target, "Escape", "keyup");
    if (input) blur(input);
    if (this.kind === "select2" && this.isOpen()) press(this.box);
  }
}

/** react-select's control box around its input (class `*__control` / `*-control`), if any. */
function controlBox(el: HTMLElement): HTMLElement | null {
  for (let a = el.parentElement, d = 0; a && d < 5; a = a.parentElement, d++) {
    if (a.querySelectorAll("[role=combobox]").length > 1) break;
    if (/(^|\s)[\w-]*(__control|-control)(\s|$)/.test(a.getAttribute("class") ?? "")) return a;
  }
  return null;
}

/** The nearest block around the control that holds no other picker (its chips and loading indicator live there). */
function shellOf(el: HTMLElement): HTMLElement {
  let best: HTMLElement = el;
  for (let a: Element | null = composedParent(el), d = 0; a && d < 6; a = composedParent(a), d++) {
    if (a.matches("form, fieldset, body") || a.querySelectorAll("[role=combobox], select, button[aria-haspopup=listbox]").length > 1) break;
    best = a as HTMLElement;
    // Greenhouse's .select-shell, a react-select root (emotion's "css-<hash>-container"), select2, a Workday field.
    if (a.matches('.select-shell, .select2-container, [data-automation-id^="formField"]') || Array.from(a.classList).some(c => /^(?:[\w]+-)?css-[a-z0-9]+-container$/.test(c))) break;
  }
  return best;
}

export interface Watch {
  /** Picks the index among the texts to take, and whether it may be taken before the list settles. */
  choose(texts: string[]): { index: number; sure: boolean } | null;
  /** Longest wait for the list (ms). */
  waitMs: number;
  /** How long a list must stay the same (and not loading) to count as settled. */
  stableMs?: number;
  /** How long to wait for a list that shows nothing at all. */
  emptyMs?: number;
}

/**
 * Watches the control's open list until `choose` names an option (taken at once when sure, else once the list has
 * settled) or the list settles without one. Every option text seen goes into `seen`.
 */
export async function watchOptions(c: Combo, w: Watch, seen: Set<string>): Promise<HTMLElement | null> {
  const start = Date.now();
  const end = start + w.waitMs;
  const stableMs = w.stableMs ?? 400;
  let last = "";
  let since = Date.now();
  for (;;) {
    const els = c.optionEls();
    const texts = els.map(o => squash(o.textContent));
    texts.forEach(t => seen.add(t));
    const busy = c.busy();
    const k = texts.join("\n");
    if (k !== last || busy) { last = k; since = Date.now(); }
    const settled = !busy && Date.now() - since >= stableMs && Date.now() - start >= 150;
    const pick = texts.length ? w.choose(texts) : null;
    if (pick && (pick.sure || settled)) return els[pick.index] ?? null;
    if (settled && (texts.length || Date.now() - start >= (w.emptyMs ?? 900))) return null;
    if (Date.now() >= end) return null;
    await sleep(80);
  }
}

/**
 * Clicks `option` and checks the control now shows it. A click the control ignored is retried from the keyboard
 * (ArrowDown to the option, then Enter — synthetic keys never submit a form). True when the control shows the option.
 */
export async function pickOption(c: Combo, option: HTMLElement): Promise<boolean> {
  const text = squash(option.textContent);
  const before = c.shown().length;
  option.scrollIntoView?.({ block: "nearest" });
  press(option);
  await sleep(120);
  if (showsValue(c, text, before)) return true;
  const input = c.input();
  if (input && option.id && option.isConnected) {
    focus(input);
    for (let i = 0; i < 400 && input.getAttribute("aria-activedescendant") !== option.id; i++) key(input, "ArrowDown");
    if (input.getAttribute("aria-activedescendant") === option.id) {
      key(input, "Enter");
      await sleep(120);
    }
  }
  return showsValue(c, text, before);
}

function showsValue(c: Combo, text: string, before: number): boolean {
  const shown = c.shown();
  const t = norm(text);
  if (shown.some(s => { const n = norm(s); return n === t || (n.length > 1 && (t.includes(n) || n.includes(t))); })) return true;
  // A multi-select's chip may be shortened; a new chip appeared.
  return c.multi() && shown.length > before;
}

/** The values a select-like combobox shows as picked (from the nearest wrapper holding them). */
export function selectedChips(el: HTMLElement): string[] {
  for (let a: HTMLElement | null = el, d = 0; a && d < 5; a = a.parentElement, d++) {
    // Never a wrapper around another picker: its chips are that field's.
    if (a.querySelectorAll("[role=combobox]").length > 1) break;
    const chips = Array.from(a.querySelectorAll(CHIP)).map(c => squash(c.textContent)).filter(Boolean);
    if (chips.length) return chips;
    if (a.matches("label, fieldset, form")) break;
  }
  return [];
}

// --- Yes/No button pairs (Ashby) ---

/** A container whose only buttons are "Yes" and "No" (Ashby's yes/no questions). */
export function isYesNoPair(el: Element): boolean {
  const buttons = Array.from(el.children).filter(c => c.tagName === "BUTTON" || c.getAttribute("role") === "button");
  return buttons.length === 2 && norm(buttons[0]!.textContent) === "yes" && norm(buttons[1]!.textContent) === "no";
}

export function yesNoButtons(el: Element): HTMLElement[] {
  return Array.from(el.children).filter(c => c.tagName === "BUTTON" || c.getAttribute("role") === "button") as HTMLElement[];
}

const pressed = (b: Element) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /(^|[\s_-])(active|selected)(_|\s|$)/i.test(b.getAttribute("class") ?? "");

/** The pressed button's text, or null. */
export function yesNoValue(el: Element): string | null {
  const on = yesNoButtons(el).find(pressed);
  return on ? squash(on.textContent) : null;
}

/** Presses the Yes or No button, unless it is already pressed (a second press would unselect it). */
export async function setYesNo(el: Element, want: string): Promise<boolean> {
  const w = norm(want);
  const b = yesNoButtons(el).find(x => norm(x.textContent) === w);
  if (!b) return false;
  if (!pressed(b)) {
    press(b);
    await sleep(80);
  }
  return norm(yesNoValue(el)) === w;
}
