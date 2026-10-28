import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { extractFields } from "../../src/forms/extract.js";

const basicHtml = readFileSync(new URL("../fixtures/forms/basic.html", import.meta.url), "utf8");
let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

test("extracts labels, kinds, required, options", async () => {
  await page.setContent(basicHtml);
  const f = await extractFields(page);
  expect(f.map(x => [x.label, x.kind, x.required])).toEqual([
    ["First Name", "text", true], ["Email", "email", true], ["LinkedIn Profile", "url", false], ["Phone", "tel", true],
    ["Why us?", "textarea", false], ["Degree", "select", true], ["Are you authorized to work in the US?", "radio", true],
    ["I certify the above is accurate", "checkbox", true], ["I agree to receive SMS updates", "checkbox", false],
    ["Which languages?", "checkbox-group", false], ["Resume", "file", true], ["School", "combobox", true],
  ]);
  expect(f.find(x => x.label === "Degree")!.options).toEqual(["Bachelor's", "Master's"]);
  expect(f.find(x => x.label === "Why us?")!.maxLength).toBe(500);
  expect(f.find(x => x.kind === "radio")!.options).toEqual(["Yes", "No"]);
  expect(f.find(x => x.kind === "checkbox-group")!.options).toEqual(["English", "Spanish", "French"]);
  expect(f.find(x => x.kind === "combobox")!.options).toContain("University of Texas at Austin");
  expect(f.find(x => x.label === "Email")!.description).toBe("We only use this for updates.");
  expect(f.find(x => x.label === "I certify the above is accurate")!.description).toBe("Consent");
});

test("ids are data-aa-id values and extraction is idempotent", async () => {
  await page.setContent(basicHtml);
  const first = await extractFields(page);
  const second = await extractFields(page);
  expect(second).toEqual(first);
  expect(new Set(first.map(x => x.id)).size).toBe(first.length);
  for (const x of first) expect(await page.locator(`[data-aa-id="${x.id}"]`).count()).toBeGreaterThan(0);
});

test("respects scope and skips fields outside it", async () => {
  await page.setContent(`<form id="a"><label for="x">X</label><input id="x"></form><form id="b"><label for="y">Y</label><input id="y"></form>`);
  expect((await extractFields(page, "#b")).map(x => x.label)).toEqual(["Y"]);
});
