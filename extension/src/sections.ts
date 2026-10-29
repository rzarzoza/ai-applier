/**
 * Repeating sections the extension leaves to the user: "Experience" and "Education" blocks a form only shows once their
 * "Add" button is clicked (SmartRecruiters' one-click form, Workday's My Experience step). Adding entries means
 * inventing their layout, so the extension never clicks "Add"; it lists each such section in the panel instead.
 */
import { composedParent, deepQueryAll } from "./dom.js";
import { isVisible, squash } from "./widgets.js";

export interface ManualSection {
  /** The section's heading ("Experience", "Education"). */
  label: string;
  /** Its "Add" button, to scroll to. */
  button: HTMLElement;
}

const ADD = /^\+?\s*add\b/i;
const SECTION = /experience|education|employment|work history/i;
const HEADING = 'h1, h2, h3, h4, h5, h6, [role=heading], legend, [class*="title" i], [class*="heading" i]';

/** The words on a button: its own text or label, else (a <button> inside a web component) its host's. */
function words(el: Element): string {
  const own = squash(el.textContent) || squash(el.getAttribute("aria-label"));
  if (own) return own;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? squash(root.host.textContent) || squash(root.host.getAttribute("aria-label")) : "";
}

/** The heading of the block an element sits in (the nearest one found climbing out, through shadow hosts). */
function headingOf(el: Element): string {
  for (let a: Element | null = composedParent(el), d = 0; a && d < 8; a = composedParent(a), d++) {
    const h = deepQueryAll(a, HEADING).find(x => isVisible(x) && squash(x.textContent) && !x.contains(el) && squash(x.textContent).length < 60);
    if (h) return squash(h.textContent);
    if (a.matches("form, main, body")) break;
  }
  return "";
}

/** The "Add experience" / "Add education" sections in `scope` (the page when none), each once. */
export function manualSections(scope: Element | null): ManualSection[] {
  const out: ManualSection[] = [];
  const seen = new Set<string>();
  for (const b of deepQueryAll(scope ?? document.body, "button, [role=button], a")) {
    if (!isVisible(b) || b.closest("#ai-applier-panel-host")) continue;
    const text = words(b);
    if (!text || text.length > 40 || !ADD.test(text)) continue;
    const label = SECTION.test(text) ? text.replace(ADD, "").replace(/^\s*(an?|another|new|more)\s+/i, "").trim() : headingOf(b);
    if (!SECTION.test(label)) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label.replace(/^\w/, c => c.toUpperCase()), button: b as HTMLElement });
  }
  return out;
}
