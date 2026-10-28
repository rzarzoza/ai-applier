import type { Frame, Locator, Page } from "playwright";
import { inPage } from "./in-page.js";
import type { FieldAnswer, FieldSpec } from "./types.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const all = (root: Page | Frame, field: FieldSpec) => root.locator(`[data-aa-id="${field.id}"]`);

const optionLabels = (members: Locator) =>
  members.evaluateAll(inPage((els: Element[]) => els.map(e => e.getAttribute("data-aa-opt") ?? ""))) as Promise<string[]>;

/** Resolves the `data-aa-opt` value of the group member matching `want` (exact, then case-insensitive). */
async function matchOption(members: Locator, want: string): Promise<string> {
  const opts = await optionLabels(members);
  const hit = opts.find(o => o === want) ?? opts.find(o => norm(o) === norm(want));
  if (hit === undefined) throw new Error(`No option "${want}" among: ${opts.join(", ")}`);
  return hit;
}

export async function fillField(root: Page | Frame, field: FieldSpec, answer: FieldAnswer): Promise<void> {
  const members = all(root, field);
  const el = members.first();
  switch (field.kind) {
    case "select":
      if (answer.type !== "option") throw new Error(`select needs an option answer`);
      await el.selectOption({ label: answer.option });
      return;
    case "combobox": {
      if (answer.type !== "option" && answer.type !== "text") throw new Error(`combobox needs an option or text answer`);
      const want = answer.type === "option" ? answer.option : answer.text;
      await el.click();
      const { input, controls } = await comboboxParts(el);
      if (input) {
        await input.fill("");
        await input.pressSequentially(want);
      }
      const options = await comboboxOptions(root, controls, 3000);
      const texts = (await options.allInnerTexts()).map(norm);
      let idx = texts.findIndex(t => t === norm(want));
      if (idx < 0) idx = texts.findIndex(t => t.startsWith(norm(want)));
      if (idx < 0) throw new Error(`No combobox option matching "${want}"`);
      await options.nth(idx).click();
      return;
    }
    case "radio": {
      if (answer.type !== "option") throw new Error(`radio needs an option answer`);
      const opt = await matchOption(members, answer.option);
      await members.and(root.locator(`[data-aa-opt=${JSON.stringify(opt)}]`)).first().check();
      return;
    }
    case "checkbox":
      if (answer.type !== "check") throw new Error(`checkbox needs a check answer`);
      await el.setChecked(answer.checked);
      return;
    case "checkbox-group": {
      if (answer.type !== "options") throw new Error(`checkbox-group needs an options answer`);
      const wanted = new Set<string>();
      for (const o of answer.options) wanted.add(await matchOption(members, o));
      const opts = await optionLabels(members);
      for (let i = 0; i < opts.length; i++) await members.nth(i).setChecked(wanted.has(opts[i]));
      return;
    }
    case "file":
      if (answer.type !== "file") throw new Error(`file needs a file answer`);
      await el.setInputFiles(answer.path);
      return;
    default:
      if (answer.type !== "text") throw new Error(`${field.kind} needs a text answer`);
      await el.fill(answer.text);
  }
}

/** The box to type into (the combobox itself or an input inside it), and the id of the listbox it controls. */
async function comboboxParts(el: Locator): Promise<{ input: Locator | null; controls: string }> {
  const info = (await el.evaluate(inPage((e: HTMLElement) => ({
    editable: e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e.isContentEditable,
    childInput: !!e.querySelector("input"),
    controls: (e.getAttribute("aria-controls") ?? e.getAttribute("aria-owns") ?? e.querySelector("input")?.getAttribute("aria-controls") ?? "").split(/\s+/)[0],
  })))) as { editable: boolean; childInput: boolean; controls: string };
  return { input: info.editable ? el : info.childInput ? el.locator("input").first() : null, controls: info.controls };
}

/** The visible options, from the combobox's own listbox when it names one; waits up to `waitMs` for any to show. */
async function comboboxOptions(root: Page | Frame, controls: string, waitMs: number): Promise<Locator> {
  const global = root.locator("[role=option]:visible");
  const scoped = controls ? root.locator(`[id=${JSON.stringify(controls)}] [role=option]:visible`) : null;
  await global.first().waitFor({ timeout: waitMs }).catch(() => {});
  return scoped && (await scoped.count()) > 0 ? scoped : global;
}

const uniqueTexts = (texts: string[]) => [...new Set(texts.map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean))];

/**
 * The option texts a choice control offers. A combobox is opened with its typed text cleared, so the whole list shows;
 * when nothing shows until something is typed (a lazy or search-as-you-type list), the first letter of `typed` is typed
 * to load matching options. With `search`, the whole of `typed` is typed instead and the options it surfaces are read
 * (a search). The control is left closed and empty. Other kinds have no options (empty list); a select or radio group
 * always gives its whole list.
 */
export async function readOptions(root: Page | Frame, field: FieldSpec, typed?: string, search = false): Promise<string[]> {
  const members = all(root, field);
  const el = members.first();
  switch (field.kind) {
    case "select":
      return el.evaluate(inPage((s: HTMLSelectElement) =>
        Array.from(s.options).filter(o => o.value !== "").map(o => (o.textContent ?? "").replace(/\s+/g, " ").trim()))) as Promise<string[]>;
    case "radio":
    case "checkbox-group":
      return uniqueTexts(await optionLabels(members));
    case "combobox": {
      await el.click();
      const { input, controls } = await comboboxParts(el);
      try {
        if (input) await input.fill("");
        if (search && input && typed?.trim()) {
          await input.pressSequentially(typed.trim());
          return uniqueTexts(await (await comboboxOptions(root, controls, 3000)).allInnerTexts());
        }
        let options = await comboboxOptions(root, controls, 1500);
        const hint = typed?.trim().slice(0, 1);
        if (!(await options.count()) && input && hint) {
          await input.pressSequentially(hint);
          options = await comboboxOptions(root, controls, 3000);
        }
        return uniqueTexts(await options.allInnerTexts());
      } finally {
        if (input) await input.fill("").catch(() => {});
        await el.press("Escape").catch(() => {});
      }
    }
    default:
      return [];
  }
}

export async function readBack(root: Page | Frame, field: FieldSpec): Promise<string | string[] | boolean | null> {
  const members = all(root, field);
  const el = members.first();
  switch (field.kind) {
    case "select": {
      const v = (await el.evaluate(inPage((s: HTMLSelectElement) => s.value === "" ? null : (s.selectedOptions[0]?.textContent ?? "").trim()))) as string | null;
      return v;
    }
    case "radio":
      return members.evaluateAll(inPage((els: Element[]) => (els.find(e => (e as HTMLInputElement).checked)?.getAttribute("data-aa-opt")) ?? null)) as Promise<string | null>;
    case "checkbox":
      return el.isChecked();
    case "checkbox-group":
      return members.evaluateAll(inPage((els: Element[]) => els.filter(e => (e as HTMLInputElement).checked).map(e => e.getAttribute("data-aa-opt") ?? ""))) as Promise<string[]>;
    case "file": {
      const names = (await el.evaluate(inPage((i: HTMLInputElement) => Array.from(i.files ?? []).map(f => f.name)))) as string[];
      return names.length === 0 ? null : names.length === 1 ? names[0] : names;
    }
    case "combobox":
      return el.evaluate(inPage((e: HTMLElement) => {
        if (e instanceof HTMLInputElement) return e.value;
        const child = e.querySelector("input");
        return child && child.value ? child.value : (e.textContent ?? "").trim();
      })) as Promise<string>;
    default:
      return el.inputValue();
  }
}
