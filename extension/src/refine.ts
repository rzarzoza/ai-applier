/**
 * Corrections to collectFields' output that the runner makes in its ATS handlers (see ats/greenhouse.ts readFields),
 * done generically so the extension asks the app about the same fields the runner would (and hits the same cached
 * classifications):
 * - an upload whose own label is only its button ("Attach", "Upload") takes the label of its group (Greenhouse wraps
 *   each upload in [role=group][aria-labelledby]), and the group's required flag;
 * - a picker's placeholder ("Select...") is not part of its description.
 */
import type { FieldSpec } from "../../src/forms/types.js";
import { membersOf } from "./fill.js";

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const GENERIC_UPLOAD = /^(attach|upload|browse|choose( a)? file|select( a)? file|add file|drop files? here)?$/i;

function textOfIds(ids: string | null): string {
  return squash((ids ?? "").split(/\s+/).filter(Boolean).map(i => document.getElementById(i)?.textContent ?? "").join(" "));
}

/** The placeholder a react-select style picker shows (by its id, else the nearest placeholder element around it). */
function placeholderOf(el: HTMLElement): string {
  const byId = el.id ? squash(document.getElementById(`react-select-${el.id}-placeholder`)?.textContent) : "";
  if (byId) return byId;
  for (let a: HTMLElement | null = el.parentElement, d = 0; a && d < 4; a = a.parentElement, d++) {
    if (a.querySelectorAll("[role=combobox]").length > 1) break;
    const ph = a.querySelector('[class*="placeholder" i]');
    if (ph) return squash(ph.textContent);
  }
  return "";
}

export function refineFields(fields: FieldSpec[]): FieldSpec[] {
  return fields.map(f => {
    const el = membersOf(f.id)[0];
    if (!el) return f;
    const out: FieldSpec = { ...f };
    if (f.kind === "file") {
      const group = el.closest("[role=group][aria-labelledby]");
      const groupLabel = group ? textOfIds(group.getAttribute("aria-labelledby")).replace(/\s*\*+\s*$/, "") : "";
      if (groupLabel) {
        out.label = groupLabel;
        out.required = f.required || group!.getAttribute("aria-required") === "true";
      } else if (GENERIC_UPLOAD.test(f.label)) {
        const legend = squash(el.closest("fieldset")?.querySelector(":scope > legend")?.textContent);
        if (legend) out.label = legend.replace(/\s*\*+\s*$/, "");
      }
    }
    if (f.kind === "combobox" && out.description) {
      const ph = placeholderOf(el);
      const description = ph ? out.description.replace(ph, "").trim() : out.description;
      if (description) out.description = description;
      else delete out.description;
    }
    return out;
  });
}
