import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { AtsHandler } from "../../src/ats/types.js";
import type { FieldAnswer, FieldSpec } from "../../src/forms/types.js";

const RESUME = fileURLToPath(new URL("../fixtures/resume-sample.pdf", import.meta.url));

/** Search text for async comboboxes (no options until you type), chosen so the first suggestion matches. */
function asyncQuery(label: string, ats: string): string {
  // Ashby's typeaheads list full place names and refuse ambiguous prefixes, so give an exact first result.
  if (ats === "ashby" && /location|city/i.test(label)) return "New York City, New York, United States";
  if (ats === "ashby" && /country/i.test(label)) return "United States";
  if (/school|university|college/i.test(label)) return "Stanford";
  if (/degree/i.test(label)) return "Bachelor";
  if (/discipline|major|field of study/i.test(label)) return "Computer";
  if (/location|city/i.test(label)) return "New York";
  return "a";
}

function dummy(f: FieldSpec, ats: string): FieldAnswer {
  switch (f.kind) {
    case "email": return { type: "text", text: "test@example.com" };
    case "tel": return { type: "text", text: "5555550100" };
    case "url": return { type: "text", text: "https://example.com" };
    case "number": return { type: "text", text: "2027" };
    case "date": return { type: "text", text: "2027-01-01" };
    case "select":
    case "radio": return { type: "option", option: f.options![0] };
    case "combobox": return f.options?.length ? { type: "option", option: f.options[0] } : { type: "text", text: asyncQuery(f.label, ats) };
    case "checkbox": return { type: "check", checked: true };
    case "checkbox-group": return { type: "options", options: [f.options![0]] };
    case "file": return { type: "file", path: RESUME };
    default: return { type: "text", text: "Test" };
  }
}

const isEmpty = (v: string | string[] | boolean | null) => v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Opens a live posting, fills every field with a kind-appropriate dummy and reads it back. NEVER clicks submit:
 * it only reports whether a submit button is visible.
 */
export async function dryRun(handler: AtsHandler, url: string): Promise<{ fields: FieldSpec[]; unfilledRequired: string[]; submitVisible: boolean }> {
  const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
  try {
    const page = await browser.newPage();
    const opened = await handler.open(page, url);
    if (!opened.ok) throw new Error(`open ${url}: ${opened.reason} ${opened.detail ?? ""}`);
    const fields = await handler.readFields(page);
    const unfilledRequired: string[] = [];
    for (const f of fields) {
      try {
        await handler.fill(page, f, dummy(f, handler.name));
      } catch (e) {
        console.warn(`[dry-run] fill "${f.label}" (${f.kind}) failed: ${(e as Error).message.split("\n")[0]}`);
      }
      const value = await handler.readBack(page, f).catch(() => null);
      if (f.required && isEmpty(value)) unfilledRequired.push(f.label);
    }
    const root = await handler.root(page);
    const submitVisible = await root.getByRole("button", { name: /submit/i }).first().isVisible();
    return { fields, unfilledRequired, submitVisible };
  } finally {
    await browser.close();
  }
}
