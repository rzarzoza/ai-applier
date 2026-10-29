/**
 * Filling the controls collectFields tagged (data-aa-id) from inside the page, in a way React and Vue forms accept:
 * values go through the element prototype's native setter followed by input/change/blur events (a framework that tracks
 * the value it last rendered then sees a real change); choices are clicked like a person would (see widgets.ts).
 *
 * Choices are matched as the runner matches them (answers/choose.ts: exact, place, country, degree, unique prefix);
 * a value none of the options takes goes to the app (/ext/adapt: the LLM mapping, then — for a name the list lacks —
 * its "Other" option, whose real value goes in the box it reveals).
 */
import { chooseOption, closestOptions, placeValue, searchQueries, type ChooseContext } from "../../src/answers/choose.js";
import { isLocationAnswer, pickLocation } from "../../src/answers/location.js";
import type { AdaptResponse, ExtAnswer, ExtHints } from "../../src/ext/protocol.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { deepQueryAll } from "./dom.js";
import {
  blur, Combo, fire, focus, inputEvent, key, isYesNoPair, isVisible, norm, pickOption, PLACEHOLDER, selectedChips, setNativeValue, setYesNo,
  sleep, squash, typeSearch, watchOptions, yesNoValue,
} from "./widgets.js";

export { press, setNativeValue } from "./widgets.js";

export type FillOutcome =
  | { ok: true; value: FieldValue; other?: string }
  | { ok: false; error: string; choices?: string[] };
export type FieldValue = string | string[] | boolean | null;

export interface AdaptCall { field: FieldSpec; value: string | string[]; options: string[]; final: boolean }

export interface FillDeps {
  /** The resume file for an upload, or null when the app has none. */
  resume(): Promise<File | null>;
  /** How long a choice list may take to show its options, per search (ms). */
  optionWaitMs?: number;
  /** The profile's place and degree status (from /ext/resolve). */
  hints?: ExtHints | null;
  /** Maps a value onto options through the app (/ext/adapt); missing or null when the app can't be asked. */
  adapt?(call: AdaptCall): Promise<AdaptResponse | null>;
}

/** The controls tagged with this field id, anywhere on the page (open shadow roots included). */
export const membersOf = (id: string): HTMLElement[] => deepQueryAll(document, `[data-aa-id="${CSS.escape(id)}"]`);

/** True for controls the extension must never write to. */
export function isForbidden(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === "password";
}

/** Types `text` into a text box as one edit: focus, native value, input, change, blur. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  focus(el);
  setNativeValue(el, text);
  inputEvent(el, text);
  fire(el, "change");
  blur(el);
}

const optLabel = (e: Element) => e.getAttribute("data-aa-opt") ?? "";

function answerText(a: ExtAnswer): string | null {
  return a.type === "text" ? a.text : a.type === "option" ? a.option : a.type === "options" ? a.options.join(", ") : null;
}

const ctxOf = (field: FieldSpec, deps: FillDeps): ChooseContext => ({ label: field.label, inProgress: deps.hints?.inProgress ?? null });

/** `No option for "USA" — options: A, B, …` and the closest options for the user to pick from. */
function noOption(value: string, seen: Iterable<string>, note = ""): { ok: false; error: string; choices?: string[] } {
  const all = [...new Set(seen)].filter(Boolean);
  const choices = closestOptions(value, all, 5);
  const list = choices.length ? ` — options: ${choices.join(", ")}${all.length > choices.length ? ", …" : ""}` : " — the list showed no options";
  return { ok: false, error: `No option for "${value}"${note}${list}`, ...(choices.length ? { choices } : {}) };
}

/** Fills one field with the app's answer. Never touches password boxes and never throws. */
export async function fillField(field: FieldSpec, answer: ExtAnswer, deps: FillDeps): Promise<FillOutcome> {
  const members = membersOf(field.id);
  const el = members[0];
  if (!el) return { ok: false, error: "The field is gone from the page" };
  if (members.some(isForbidden)) return { ok: false, error: "Password fields are never filled" };
  let other: string | undefined;
  try {
    switch (field.kind) {
      case "select": {
        const want = answerText(answer);
        if (want === null || !(el instanceof HTMLSelectElement)) return { ok: false, error: "A list needs one of its options" };
        const opts = Array.from(el.options).filter(o => o.value !== "" || squash(o.textContent) !== "");
        const labels = opts.map(o => squash(o.label || o.textContent));
        const r = await choose(field, want, labels.filter((_, i) => opts[i]!.value !== ""), deps);
        if (!r.ok) return r;
        const j = labels.indexOf(r.option);
        if (j < 0) return noOption(want, labels);
        other = r.other;
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
        if (!(el instanceof HTMLInputElement) && isYesNoPair(el)) {
          // A Yes/No button pair (Ashby): press the one that matches, unless it already is.
          const r = await choose(field, want, ["Yes", "No"], deps);
          if (!r.ok) return r;
          if (!(await setYesNo(el, r.option))) return { ok: false, error: `Pressed "${r.option}" but the question still shows ${yesNoValue(el) ?? "nothing"}` };
          break;
        }
        const labels = members.map(optLabel);
        const r = await choose(field, want, labels, deps);
        if (!r.ok) return r;
        other = r.other;
        const target = members[labels.indexOf(r.option)] as HTMLInputElement;
        if (!target.checked) target.click();
        break;
      }
      case "checkbox": {
        const want = answer.type === "check" ? answer.checked : answer.type === "text" || answer.type === "option" ? /^(yes|true|y|i agree|agree)$/i.test(answerText(answer)!.trim()) : null;
        if (want === null || !(el instanceof HTMLInputElement)) return { ok: false, error: "A tick box needs yes or no" };
        if (el.checked !== want) el.click();
        break;
      }
      case "checkbox-group": {
        const wanted = answer.type === "options" ? answer.options : answer.type === "option" ? [answer.option] : answer.type === "text" ? splitList(answer.text) : null;
        if (!wanted) return { ok: false, error: "Tick boxes need a list of options" };
        const labels = members.map(optLabel);
        const picked = await chooseMany(field, wanted, labels, deps);
        if (!picked.ok) return picked;
        members.forEach((m, i) => {
          const box = m as HTMLInputElement;
          if (box.checked !== picked.options.includes(labels[i]!)) box.click();
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
        const want = answer.type === "options" ? answer.options : answerText(answer);
        if (want === null) return { ok: false, error: "A list needs one of its options" };
        const r = await fillCombo(field, el, want, deps);
        if (!r.ok) return r;
        other = r.other;
        break;
      }
      default: {
        const text = answerText(answer);
        if (text === null || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { ok: false, error: "A text box needs text" };
        if (el instanceof HTMLInputElement && (isLocationAnswer(field, text) || isAutocomplete(el))) {
          // A search box that doesn't call itself a combobox (a city search, an autocomplete): type the value, and when
          // suggestions show, pick the matching one (a place: only that city in that state); else keep the typed text.
          const target = placeValue(field.label, text, deps.hints?.place);
          typeSearch(el, text);
          const c = new Combo(el);
          const opt = await watchOptions(c, {
            waitMs: Math.min(deps.optionWaitMs ?? 2500, 1500), emptyMs: 700,
            choose: texts => {
              const p = isLocationAnswer(field, text) ? pickLocation(target, texts) : texts.find(t => norm(t) === norm(text)) ?? null;
              return p === null ? null : { index: texts.indexOf(p), sure: false };
            },
          }, new Set());
          if (opt) await pickOption(c, opt);
          else { fire(el, "change"); blur(el); }
          break;
        }
        typeInto(el, el instanceof HTMLTextAreaElement ? text : text.replace(/\s*[\r\n]+\s*/g, " "));
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, value: readValue(field), ...(other ? { other } : {}) };
}

const isAutocomplete = (el: HTMLInputElement) => /^(list|both)$/i.test(el.getAttribute("aria-autocomplete") ?? "") || el.getAttribute("role") === "combobox";

/** "A, B; C" as its parts (a multi-select's answer stored as one text). */
const splitList = (text: string) => text.split(/\s*[,;\n]\s*/).map(s => s.trim()).filter(Boolean);

type Chosen = { ok: true; option: string; other?: string } | { ok: false; error: string; choices?: string[] };

/** The option a value stands for among known options: the chooser, else the app's mapping (with its Other fallback). */
async function choose(field: FieldSpec, value: string, options: string[], deps: FillDeps): Promise<Chosen> {
  const target = placeValue(field.label, value, deps.hints?.place);
  const hit = chooseOption(target, options, ctxOf(field, deps));
  if (hit) return { ok: true, option: hit.option };
  const r = await deps.adapt?.({ field: { ...field, options }, value, options, final: true }).catch(() => null);
  const a = r?.answer;
  const picked = a?.type === "option" ? a.option : a?.type === "text" ? a.text : null;
  if (picked !== null && picked !== undefined && options.includes(picked)) return { ok: true, option: picked, ...(r?.other ? { other: r.other } : {}) };
  return noOption(target, options);
}

async function chooseMany(field: FieldSpec, wanted: string[], options: string[], deps: FillDeps): Promise<{ ok: true; options: string[] } | { ok: false; error: string; choices?: string[] }> {
  const ctx = ctxOf(field, deps);
  const picks = wanted.map(w => chooseOption(w, options, ctx)?.option ?? null);
  if (picks.every(p => p !== null)) return { ok: true, options: [...new Set(picks as string[])] };
  const r = await deps.adapt?.({ field: { ...field, kind: "checkbox-group", options }, value: wanted, options, final: true }).catch(() => null);
  const a = r?.answer;
  const list = a?.type === "options" ? a.options : a?.type === "option" ? [a.option] : null;
  if (list?.length && list.every(o => options.includes(o))) return { ok: true, options: list };
  const missing = wanted[picks.findIndex(p => p === null)]!;
  return noOption(missing, options);
}

/**
 * Picks the answer in a custom combobox (react-select, select2, a listbox button, a typeahead): opens it and takes the
 * matching option from the list it shows; a lazy or searchable list is searched (the value, then the words its kind of
 * answer is listed under: "City, ST", "United States", "Bachelor"...). Nothing matching: the options it showed go to the
 * app (/ext/adapt), which may name other spellings to search, and finally the list's "Other" for a name it lacks. A
 * multi-select takes each value in turn.
 */
async function fillCombo(field: FieldSpec, box: HTMLElement, want: string | string[], deps: FillDeps): Promise<{ ok: true; other?: string } | { ok: false; error: string; choices?: string[] }> {
  const c = new Combo(box);
  await c.open();
  const multi = c.multi();
  const values = Array.isArray(want) ? want : multi && !isLocationAnswer(field, want) ? splitList(want) : [want];
  let other: string | undefined;
  for (const v of values) {
    if (multi && c.shown().some(s => norm(s) === norm(v))) continue;
    const r = await pickOne(field, c, v, deps);
    if (!r.ok) { c.close(true); return r; }
    other ??= r.other;
  }
  c.close(false);
  await sleep(50);
  return { ok: true, ...(other ? { other } : {}) };
}

async function pickOne(field: FieldSpec, c: Combo, value: string, deps: FillDeps): Promise<{ ok: true; other?: string } | { ok: false; error: string; choices?: string[] }> {
  const ctx = ctxOf(field, deps);
  const target = placeValue(field.label, value, deps.hints?.place);
  const waitMs = deps.optionWaitMs ?? 4000;
  const seen = new Set<string>();
  const searched = new Set<string>();
  const byChooser = (v: string) => (texts: string[]) => {
    const hit = chooseOption(v, texts, ctx);
    return hit ? { index: texts.indexOf(hit.option), sure: hit.sure } : null;
  };
  const exactly = (option: string) => (texts: string[]) => {
    const i = texts.findIndex(t => norm(t) === norm(option));
    return i >= 0 ? { index: i, sure: true } : null;
  };
  const take = async (el: HTMLElement): Promise<boolean> => {
    if (await pickOption(c, el)) return true;
    throw new Error(`Clicked "${squash(el.textContent)}" but the field doesn't show it`);
  };
  /** Opens the list (cleared) and waits for what it shows by itself. */
  const browse = async (choose: ReturnType<typeof byChooser>) => {
    const input = c.input();
    if (input?.value) { setNativeValue(input, ""); inputEvent(input, null); }
    await c.open();
    return watchOptions(c, { choose, waitMs: Math.min(waitMs, 2500), emptyMs: 700 }, seen);
  };
  /** Types each query into the control's search box and watches the results (`again`: even one typed before). */
  const search = async (queries: string[], choose: ReturnType<typeof byChooser>, again = false) => {
    for (const q of queries) {
      const k = norm(q);
      if (!k || (searched.has(k) && !again)) continue;
      searched.add(k);
      await c.open();
      const input = c.input();
      if (!input) return null;
      typeSearch(input, q);
      await sleep(150); // let an async search start before reading
      const el = await watchOptions(c, { choose, waitMs, emptyMs: 1200 }, seen);
      if (el) return el;
      if (c.box.getAttribute("data-uxi-widget-type") === "selectinput") {
        // Workday's prompt searches on Enter (a synthetic key never submits anything).
        key(input, "Enter");
        const again = await watchOptions(c, { choose, waitMs, emptyMs: 1200 }, seen);
        if (again) return again;
      }
    }
    return null;
  };

  const place = isLocationAnswer(field, target);
  // 1. The list as it opens (places are never listed until searched).
  let el = place ? null : await browse(byChooser(target));
  // 2. Searches.
  el ??= await search(searchQueries(target, ctx), byChooser(target));
  if (el) return take(el).then(() => ({ ok: true as const }));

  // 3. The app maps the value onto what the list showed; it may name other spellings to look for first.
  const ask = (final: boolean) => deps.adapt?.({ field, value, options: [...seen].slice(0, 2000), final }).catch(() => null) ?? Promise.resolve(null);
  const named = async (r: AdaptResponse | null) => {
    const a = r?.answer;
    const opts = a?.type === "option" ? [a.option] : a?.type === "options" ? a.options : a?.type === "text" ? [a.text] : [];
    for (const o of opts.slice(0, 1)) {
      const hit = (await browse(exactly(o))) ?? (await search([o], exactly(o), true));
      if (hit) { await take(hit); return true; }
    }
    return false;
  };
  if (!place && deps.adapt) {
    let r = await ask(false);
    if (await named(r)) return { ok: true, ...(r?.other ? { other: r.other } : {}) };
    if (r?.variants?.length) {
      el = await search(r.variants, byChooser(r.variants[0]!));
      for (const v of r.variants) {
        if (el) break;
        el = await search([v], byChooser(v));
      }
      if (el) return take(el).then(() => ({ ok: true as const }));
    }
    if (r?.otherAllowed) {
      // A lazy list may only show its "Other" once it is searched.
      await search(["Other"], () => null);
      r = await ask(true);
      if (await named(r)) return { ok: true, ...(r?.other ? { other: r.other } : {}) };
    }
  }
  return noOption(target, seen, place ? " in that city and state" : "");
}

/** What the field holds now (as the user would submit it). */
export function readValue(field: FieldSpec): FieldValue {
  const members = membersOf(field.id);
  const el = members[0];
  if (!el) return null;
  switch (field.kind) {
    case "select": {
      const s = el as HTMLSelectElement;
      return s.value === "" ? null : squash(s.selectedOptions[0]?.textContent);
    }
    case "radio": {
      if (!(el instanceof HTMLInputElement) && isYesNoPair(el)) return yesNoValue(el);
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
      const c = new Combo(el);
      if (c.kind === "select2" || c.kind === "button") {
        const shown = c.shown();
        return shown.length === 0 ? null : shown.length === 1 ? shown[0]! : shown;
      }
      const input = el instanceof HTMLInputElement ? el : el.querySelector("input");
      if (input?.value) return input.value;
      const picked = selectedChips(el);
      if (picked.length) return picked.length === 1 ? picked[0]! : picked;
      const text = el instanceof HTMLInputElement ? "" : squash(el.textContent);
      return PLACEHOLDER.test(text) ? "" : text;
    }
    default:
      return (el as HTMLInputElement).value;
  }
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

/** Whether an element is shown (re-exported for the content script). */
export { isVisible };
