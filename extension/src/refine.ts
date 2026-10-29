/**
 * Corrections to collectFields' output that the runner makes in its ATS handlers (ats/greenhouse.ts, lever.ts,
 * ashby.ts readFields), done generically so the extension asks the app about the same fields the runner would (and
 * hits the same cached classifications), plus the controls collectFields doesn't see:
 * - an upload whose own label is only its button ("Attach", "Upload") takes the label of its group (Greenhouse wraps
 *   each upload in [role=group][aria-labelledby]), and the group's required flag;
 * - a picker's placeholder ("Select...") is not part of its description;
 * - Lever's question labels drop their "✱" (it means required), and take the question's own label;
 * - Ashby's "Autofill from resume" widget is never a field, and its Yes/No button pairs are radio questions;
 * - Workday's dropdown buttons (button[aria-haspopup=listbox]) and multiselect prompts are comboboxes.
 */
import type { FieldSpec } from "../../src/forms/types.js";
import { byIdNear, composedParent, deepQueryAll } from "./dom.js";
import { membersOf } from "./fill.js";
import { isVisible, isYesNoPair, squash } from "./widgets.js";

const GENERIC_UPLOAD = /^(attach|upload|browse|choose( a)? file|select( a)? file|add file|drop files? here)?$/i;
const STAR = /\s*[*✱]+\s*$/;
/** Ashby's "Autofill from resume" widget (its own file input re-parses the resume over the form). */
const AUTOFILL = '[class*="ashby-application-form-autofill"]';
/** Workday-style buttons that open a listbox, and other non-input pickers collectFields doesn't tag. */
const LISTBOX_BUTTON = 'button[aria-haspopup="listbox"], [role=button][aria-haspopup="listbox"]';

function textOfIds(ids: string | null, ctx: Element): string {
  return squash((ids ?? "").split(/\s+/).filter(Boolean).filter(i => i !== ctx.id).map(i => byIdNear(ctx, i)?.textContent ?? "").join(" "));
}

/** The placeholder a react-select style picker shows (by its id, else the nearest placeholder element around it). */
function placeholderOf(el: HTMLElement): string {
  const byId = el.id ? squash(byIdNear(el, `react-select-${el.id}-placeholder`)?.textContent) : "";
  if (byId) return byId;
  for (let a: HTMLElement | null = el.parentElement, d = 0; a && d < 4; a = a.parentElement, d++) {
    if (a.querySelectorAll("[role=combobox]").length > 1) break;
    const ph = a.querySelector('[class*="placeholder" i]');
    if (ph) return squash(ph.textContent);
  }
  return "";
}

/** Lever's question label (`li.application-question .application-label`), without its "✱"; and whether it had one. */
function leverLabel(el: Element): { label: string; required: boolean } | null {
  const label = el.closest(".application-question")?.querySelector(".application-label");
  if (!label) return null;
  const clone = label.cloneNode(true) as Element;
  const required = !!clone.querySelector(".required") || STAR.test(squash(clone.textContent));
  clone.querySelectorAll(".required, a, svg, button, input, select, textarea").forEach(n => n.remove());
  const text = squash(clone.textContent).replace(STAR, "");
  return text ? { label: text, required } : null;
}

/** The question a control without its own label answers (a Yes/No pair, a listbox button), and whether it's required. */
function questionOf(el: HTMLElement): { label: string; required: boolean } {
  const out = (raw: string, req = false) => ({ label: raw.replace(STAR, "").trim(), required: req || STAR.test(raw) });
  // Ashby: the entry's question title (a required one has a hashed `_required_` class).
  const entry = el.closest(".ashby-application-form-field-entry, [data-field-path]");
  const title = entry?.querySelector(".ashby-application-form-question-title");
  if (title) return out(squash(title.textContent), /(^|\s)_required_/.test(title.getAttribute("class") ?? ""));
  const lever = leverLabel(el);
  if (lever) return lever;
  const req = el.getAttribute("aria-required") === "true";
  if (el.id) {
    const forLabel = Array.from((el.getRootNode() as Document | ShadowRoot).querySelectorAll("label")).find(l => l.getAttribute("for") === el.id);
    if (forLabel && squash(forLabel.textContent)) return out(squash(forLabel.textContent), req || !!forLabel.querySelector("abbr[title*=required i]"));
  }
  // Workday: the form field's own label.
  const wd = el.closest('[data-automation-id^="formField"]')?.querySelector("label, legend");
  if (wd && squash(wd.textContent)) return out(squash(wd.textContent), req || !!wd.querySelector("abbr"));
  const byIds = textOfIds(el.getAttribute("aria-labelledby"), el);
  if (byIds) return out(byIds, req);
  const legend = el.closest("fieldset")?.querySelector(":scope > legend");
  if (legend && squash(legend.textContent)) return out(squash(legend.textContent), req);
  const aria = squash(el.getAttribute("aria-label"));
  if (aria) return out(aria, req);
  for (let n: Element | null = el; n; n = n.parentElement) {
    for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
      if (p.querySelector("input, select, textarea, button") || !isVisible(p)) continue;
      const t = squash(p.textContent);
      if (t) return out(t, req);
    }
  }
  return out("", req);
}

function nextId(): () => string {
  let counter = 0;
  deepQueryAll(document, "[data-aa-id]").forEach(e => {
    const n = Number(/^f(\d+)$/.exec(e.getAttribute("data-aa-id") ?? "")?.[1]);
    if (n > counter) counter = n;
  });
  return () => `f${++counter}`;
}

/** Fields collectFields doesn't see: Yes/No button pairs and listbox buttons inside the scope. */
function extraFields(scope: Element, known: Set<string>): FieldSpec[] {
  const out: FieldSpec[] = [];
  const id = nextId();
  const tag = (el: HTMLElement) => {
    const existing = el.getAttribute("data-aa-id");
    if (existing && known.has(existing)) return null;
    const fid = existing ?? id();
    el.setAttribute("data-aa-id", fid);
    return fid;
  };
  const seenParents = new Set<Element>();
  for (const b of deepQueryAll(scope, "button, [role=button]")) {
    const parent = b.parentElement;
    if (!parent || seenParents.has(parent)) continue;
    seenParents.add(parent);
    if (!isYesNoPair(parent) || !isVisible(parent) || parent.closest(AUTOFILL)) continue;
    const fid = tag(parent);
    if (!fid) continue;
    const q = questionOf(parent);
    out.push({ id: fid, label: q.label, kind: "radio", required: q.required, options: ["Yes", "No"] });
  }
  for (const b of deepQueryAll(scope, LISTBOX_BUTTON)) {
    if (!isVisible(b) || b.closest(AUTOFILL) || b.closest("#ai-applier-panel-host") || b.closest("[role=combobox]")) continue;
    const fid = tag(b);
    if (!fid) continue;
    const q = questionOf(b);
    out.push({ id: fid, label: q.label, kind: "combobox", required: q.required });
  }
  return out;
}

/** Document order of two elements (through shadow hosts). */
function before(a: Element, b: Element): number {
  const light = (e: Element) => { let n: Element = e; for (let r = n.getRootNode(); r instanceof ShadowRoot; r = n.getRootNode()) n = r.host; return n; };
  const x = light(a);
  const y = light(b);
  if (x === y) return 0;
  return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

export function refineFields(fields: FieldSpec[], scope?: Element | null): FieldSpec[] {
  const refined = fields.flatMap((f): FieldSpec[] => {
    const el = membersOf(f.id)[0];
    if (!el) return [f];
    if (el.closest(AUTOFILL)) return [];
    // The visually hidden checkbox inside a Yes/No pair is the pair's own state, not a question.
    if (f.kind === "checkbox" && el.parentElement && (isYesNoPair(el.parentElement) || (composedParent(el.parentElement) && isYesNoPair(composedParent(el.parentElement)!)))) return [];
    const out: FieldSpec = { ...f };
    if (f.kind === "file") {
      const group = el.closest("[role=group][aria-labelledby]");
      const groupLabel = group ? textOfIds(group.getAttribute("aria-labelledby"), group).replace(STAR, "") : "";
      if (groupLabel) {
        out.label = groupLabel;
        out.required = f.required || group!.getAttribute("aria-required") === "true";
      } else if (GENERIC_UPLOAD.test(f.label)) {
        const legend = squash(el.closest("fieldset")?.querySelector(":scope > legend")?.textContent);
        if (legend) out.label = legend.replace(STAR, "");
      }
    }
    if (f.kind === "combobox" && out.description) {
      const ph = placeholderOf(el);
      const description = ph ? out.description.replace(ph, "").trim() : out.description;
      if (description) out.description = description;
      else delete out.description;
    }
    // Workday's multiselect prompt ("How Did You Hear About Us?") is a list to pick from, not a text box.
    if (f.kind === "text" && el.getAttribute("data-uxi-widget-type") === "selectinput") out.kind = "combobox";
    // Ashby: the entry's question title, required by its hashed `_required_` class (the attribute is only on text boxes).
    const title = el.closest(".ashby-application-form-field-entry, [data-field-path]")?.querySelector(".ashby-application-form-question-title");
    if (title && f.kind !== "checkbox" && !el.closest(".ashby-application-form-texting-consent-description")) {
      const t = squash(title.textContent).replace(STAR, "");
      if (t) out.label = t;
      out.required ||= /(^|\s)_required_/.test(title.getAttribute("class") ?? "");
    }
    // Lever: the question's own label, without its "✱" (a lone checkbox is its own question: its option text).
    const lever = leverLabel(el);
    if (lever && f.kind !== "checkbox") { out.label = lever.label; out.required ||= lever.required; }
    if (STAR.test(out.label)) { out.label = out.label.replace(STAR, "").trim(); out.required = true; }
    return [out];
  });
  if (!scope) return refined;
  const extra = extraFields(scope, new Set(refined.map(f => f.id)));
  if (!extra.length) return refined;
  const all = [...refined, ...extra];
  const first = new Map(all.map(f => [f.id, membersOf(f.id)[0]]));
  return all.sort((a, b) => {
    const x = first.get(a.id);
    const y = first.get(b.id);
    return x && y ? before(x, y) : 0;
  });
}
