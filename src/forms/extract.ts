import type { Frame, Page } from "playwright";
import { collectFields } from "./collect.js";
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
