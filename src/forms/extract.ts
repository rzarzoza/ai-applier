import type { Frame, Page } from "playwright";
import { inPage } from "./in-page.js";
import type { FieldSpec } from "./types.js";

/** Finds visible controls inside `scope` and tags each with `data-aa-id`; group members share one id. */
export async function extractFields(root: Page | Frame, scope = "form"): Promise<FieldSpec[]> {
  const fields = (await root.evaluate(inPage(collectFields), scope)) as FieldSpec[];
  for (const f of fields) {
    if (f.kind === "combobox") f.options = await readComboboxOptions(root, f.id);
  }
  return fields;
}

async function readComboboxOptions(root: Page | Frame, id: string): Promise<string[] | undefined> {
  const box = root.locator(`[data-aa-id="${id}"]`).first();
  const visibleOptions = root.locator("[role=option]:visible");
  try {
    await box.click({ timeout: 2000 });
    await visibleOptions.first().waitFor({ timeout: 500 }).catch(() => {});
    const texts = (await visibleOptions.allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    return texts.length ? texts : undefined;
  } catch {
    return undefined;
  } finally {
    await box.press("Escape").catch(() => {});
  }
}

// Runs inside the page: must be self-contained.
function collectFields(scope: string): FieldSpec[] {
  const scopeEl = document.querySelector(scope);
  if (!scopeEl) return [];
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const isVisible = (e: Element) =>
    e.checkVisibility({ visibilityProperty: true }) && (e.getClientRects().length > 0);
  const textOfIds = (ids: string | null) =>
    squash((ids ?? "").split(/\s+/).filter(Boolean).map(i => document.getElementById(i)?.textContent ?? "").join(" "));
  const hasControl = (e: Element) => !!e.querySelector("input, select, textarea, button");
  const ownLabelText = (label: Element) => {
    const clone = label.cloneNode(true) as Element;
    clone.querySelectorAll("input, select, textarea, button, [role=combobox]").forEach(n => n.remove());
    return squash(clone.textContent);
  };
  const precedingText = (el: Element): string => {
    let node: Element | null = el.closest("label") ?? el;
    while (node && node !== scopeEl) {
      for (let p = node.previousElementSibling; p; p = p.previousElementSibling) {
        if (hasControl(p) || !isVisible(p)) continue;
        const t = squash(p.textContent);
        if (t) return t;
      }
      node = node.parentElement;
    }
    return "";
  };
  const labelFor = (el: Element): string => {
    const byIds = textOfIds(el.getAttribute("aria-labelledby"));
    if (byIds) return byIds;
    const forId = el.getAttribute("id");
    if (forId) {
      const l = Array.from(document.querySelectorAll("label")).find(x => x.getAttribute("for") === forId);
      if (l && ownLabelText(l)) return ownLabelText(l);
    }
    const wrap = el.closest("label");
    if (wrap && ownLabelText(wrap)) return ownLabelText(wrap);
    const aria = squash(el.getAttribute("aria-label"));
    if (aria) return aria;
    return groupLabel(el) || precedingText(el);
  };
  const groupContainer = (el: Element) => el.closest("fieldset, [role=radiogroup], [role=group]");
  const groupLabel = (el: Element): string => {
    const g = groupContainer(el);
    if (!g) return "";
    return textOfIds(g.getAttribute("aria-labelledby")) ||
      squash(g.querySelector(":scope > legend")?.textContent) || squash(g.getAttribute("aria-label"));
  };
  const describe = (el: Element): string => {
    const byIds = textOfIds(el.getAttribute("aria-describedby"));
    if (byIds) return byIds;
    const sib = el.closest("label")?.nextElementSibling ?? el.nextElementSibling;
    if (sib && sib.matches(".hint, .help, .description, small, [class*=help], [class*=hint]")) return squash(sib.textContent);
    return "";
  };
  const hasVisibleTrigger = (el: Element) => {
    const id = el.getAttribute("id");
    const labels = [el.closest("label"), ...(id ? Array.from(document.querySelectorAll("label")).filter(l => l.getAttribute("for") === id) : [])];
    if (labels.some(l => l && isVisible(l))) return true;
    for (let a = el.parentElement, depth = 0; a && depth < 3 && a !== scopeEl; a = a.parentElement, depth++) {
      if (Array.from(a.querySelectorAll("button, [role=button], label")).some(t => t !== el && !t.contains(el) && !t.matches(`label[for]:not([for="${id ?? ""}"])`) && isVisible(t))) return true;
    }
    return false;
  };

  let counter = 0;
  document.querySelectorAll("[data-aa-id]").forEach(e => {
    const n = Number(/^f(\d+)$/.exec(e.getAttribute("data-aa-id") ?? "")?.[1]);
    if (n > counter) counter = n;
  });

  type Ctl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement;
  const controls = Array.from(scopeEl.querySelectorAll<Ctl>("input, select, textarea, [role=combobox]")).filter(e => {
    if (e instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image"].includes(e.type)) return false;
    if (e instanceof HTMLInputElement && e.type === "file") return isVisible(e) || hasVisibleTrigger(e);
    return isVisible(e);
  });

  const out: FieldSpec[] = [];
  const groups = new Map<string, HTMLInputElement[]>();
  const order: (Ctl | string)[] = [];
  for (const el of controls) {
    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox") && el.name) {
      const key = `${el.type}:${el.name}`;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push(el);
    } else order.push(el);
  }
  const idFor = (els: Element[]) => {
    const existing = els.map(e => e.getAttribute("data-aa-id")).find(Boolean);
    const id = existing ?? `f${++counter}`;
    els.forEach(e => e.setAttribute("data-aa-id", id));
    return id;
  };
  const star = /\s*\*+\s*$/;
  const finish = (spec: Omit<FieldSpec, "label" | "required"> & { rawLabel: string; required: boolean }) => {
    const { rawLabel, required, ...rest } = spec;
    const label = rawLabel.replace(star, "").trim();
    out.push({ ...rest, label, required: required || star.test(rawLabel) });
  };
  const setOpt = (el: HTMLInputElement) => {
    const l = el.closest("label") ? ownLabelText(el.closest("label")!)
      : (el.id ? Array.from(document.querySelectorAll("label")).filter(x => x.getAttribute("for") === el.id).map(ownLabelText).find(Boolean) : "") ||
        squash(el.getAttribute("aria-label")) || textOfIds(el.getAttribute("aria-labelledby"));
    el.setAttribute("data-aa-opt", l || el.value);
    return l || el.value;
  };

  for (const item of order) {
    if (typeof item === "string") {
      const members = groups.get(item)!;
      const id = idFor(members);
      const options = members.map(setOpt);
      const first = members[0];
      const isRadio = first.type === "radio";
      const g = groupContainer(first);
      const kind = isRadio ? "radio" : members.length > 1 ? "checkbox-group" : "checkbox";
      let rawLabel: string;
      let description = "";
      if (kind === "checkbox") {
        rawLabel = options[0];
        description = [groupLabel(first), describe(first)].filter(Boolean).join(" - ");
      } else {
        rawLabel = groupLabel(first) || precedingText(first);
        description = g ? textOfIds(g.getAttribute("aria-describedby")) : "";
      }
      const required = members.some(m => m.required || m.getAttribute("aria-required") === "true") || g?.getAttribute("aria-required") === "true";
      finish({ id, kind, rawLabel, required, ...(kind === "checkbox" ? {} : { options }), ...(description ? { description } : {}) });
      continue;
    }
    const el = item;
    const id = idFor([el]);
    let kind: FieldSpec["kind"];
    if (el.getAttribute("role") === "combobox") kind = "combobox";
    else if (el instanceof HTMLSelectElement) kind = "select";
    else if (el instanceof HTMLTextAreaElement) kind = "textarea";
    else {
      const t = (el as HTMLInputElement).type;
      kind = t === "email" || t === "tel" || t === "url" || t === "number" || t === "date" || t === "file" ? t
        : t === "radio" || t === "checkbox" ? t : "text";
    }
    let options: string[] | undefined;
    if (el instanceof HTMLSelectElement) {
      options = Array.from(el.options).filter(o => o.value !== "").map(o => squash(o.textContent));
    } else if (kind === "radio" || kind === "checkbox") {
      setOpt(el as HTMLInputElement);
    }
    const maxLen = el.getAttribute("maxlength");
    const description = describe(el);
    finish({
      id, kind, rawLabel: labelFor(el),
      required: (el as HTMLInputElement).required === true || el.getAttribute("aria-required") === "true",
      ...(options ? { options } : {}),
      ...(maxLen && Number(maxLen) > 0 ? { maxLength: Number(maxLen) } : {}),
      ...(description ? { description } : {}),
    });
  }
  return out;
}
