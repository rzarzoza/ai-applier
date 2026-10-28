import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { extractFields } from "../../src/forms/extract.js";
import { fillField, readBack } from "../../src/forms/fill.js";
import type { FieldAnswer, FieldSpec } from "../../src/forms/types.js";

const basicHtml = readFileSync(new URL("../fixtures/forms/basic.html", import.meta.url), "utf8");
let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

test("fillField + readBack round-trip every kind", async () => {
  await page.setContent(basicHtml);
  const fields = await extractFields(page);
  const by = (label: string): FieldSpec => fields.find(x => x.label === label)!;
  const dir = mkdtempSync(join(tmpdir(), "aa-"));
  const pdf = join(dir, "resume.pdf");
  writeFileSync(pdf, "%PDF-1.4");

  const text = (t: string): FieldAnswer => ({ type: "text", text: t });
  const set = async (label: string, a: FieldAnswer) => fillField(page, by(label), a);

  await set("First Name", text("Ada"));
  expect(await readBack(page, by("First Name"))).toBe("Ada");
  await set("Email", text("ada@example.com"));
  expect(await readBack(page, by("Email"))).toBe("ada@example.com");
  await set("Why us?", text("Great mission."));
  expect(await readBack(page, by("Why us?"))).toBe("Great mission.");

  await set("Degree", { type: "option", option: "Master's" });
  expect(await readBack(page, by("Degree"))).toBe("Master's");

  await set("Are you authorized to work in the US?", { type: "option", option: "No" });
  expect(await readBack(page, by("Are you authorized to work in the US?"))).toBe("No");

  await set("I certify the above is accurate", { type: "check", checked: true });
  expect(await readBack(page, by("I certify the above is accurate"))).toBe(true);
  expect(await readBack(page, by("I agree to receive SMS updates"))).toBe(false);
  await set("I certify the above is accurate", { type: "check", checked: false });
  expect(await readBack(page, by("I certify the above is accurate"))).toBe(false);

  expect(await readBack(page, by("Which languages?"))).toEqual([]);
  await set("Which languages?", { type: "options", options: ["English", "French"] });
  expect(await readBack(page, by("Which languages?"))).toEqual(["English", "French"]);

  expect(await readBack(page, by("Resume"))).toBeNull();
  await set("Resume", { type: "file", path: pdf });
  expect(await readBack(page, by("Resume"))).toBe("resume.pdf");

  await set("School", { type: "option", option: "University of Texas at Austin" });
  expect(await readBack(page, by("School"))).toBe("University of Texas at Austin");
});

test("non-editable div[role=combobox] round-trips", async () => {
  await page.setContent(basicHtml);
  const dept = (await extractFields(page)).find(x => x.label === "Department")!;
  expect(await readBack(page, dept)).toBe("Select...");
  await fillField(page, dept, { type: "option", option: "Data Science" });
  expect(await readBack(page, dept)).toBe("Data Science");
});

test("combobox falls back to an option that starts with the answer", async () => {
  await page.setContent(basicHtml);
  const school = (await extractFields(page)).find(x => x.label === "School")!;
  await fillField(page, school, { type: "option", option: "Stanford" });
  expect(await readBack(page, school)).toBe("Stanford University");
});

test("readBack of an unselected radio group and select is null", async () => {
  await page.setContent(basicHtml);
  const fields = await extractFields(page);
  expect(await readBack(page, fields.find(x => x.kind === "radio")!)).toBeNull();
  expect(await readBack(page, fields.find(x => x.kind === "select")!)).toBeNull();
});

test("a select or radio answer the control does not list fails fast with a recoverable error; case/whitespace are ignored", async () => {
  await page.setContent(basicHtml);
  const fields = await extractFields(page);
  const degree = fields.find(x => x.label === "Degree")!;
  const auth = fields.find(x => x.kind === "radio")!;
  const started = Date.now();
  await expect(fillField(page, degree, { type: "option", option: "B.S." })).rejects.toThrow(/^No option matching "B\.S\."/);
  await expect(fillField(page, auth, { type: "option", option: "Maybe" })).rejects.toThrow(/^No option matching "Maybe"/);
  expect(Date.now() - started).toBeLessThan(2000);
  await fillField(page, degree, { type: "option", option: "  master's " });
  expect(await readBack(page, degree)).toBe("Master's");
  await fillField(page, auth, { type: "option", option: "yes" });
  expect(await readBack(page, auth)).toBe("Yes");
});
