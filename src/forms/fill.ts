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
      const info = (await el.evaluate(inPage((e: HTMLElement) => ({
        editable: e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e.isContentEditable,
        childInput: !!e.querySelector("input"),
        controls: (e.getAttribute("aria-controls") ?? e.getAttribute("aria-owns") ?? e.querySelector("input")?.getAttribute("aria-controls") ?? "").split(/\s+/)[0],
      })))) as { editable: boolean; childInput: boolean; controls: string };
      if (info.editable) {
        await el.fill("");
        await el.pressSequentially(want);
      } else if (info.childInput) {
        const input = el.locator("input").first();
        await input.fill("");
        await input.pressSequentially(want);
      }
      const global = root.locator("[role=option]:visible");
      const scoped = info.controls ? root.locator(`[id=${JSON.stringify(info.controls)}] [role=option]:visible`) : null;
      await global.first().waitFor({ timeout: 3000 });
      const options = scoped && (await scoped.count()) > 0 ? scoped : global;
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
