import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { fillField } from "../../src/forms/fill.js";
import { currentPace, HUMAN_PACE, NO_PACE, paceFromEnv, pick, setPace } from "../../src/forms/pace.js";
import type { FieldSpec } from "../../src/forms/types.js";

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 800, height: 600 } }); });
afterAll(async () => { await browser.close(); });
afterEach(() => setPace(null));

const field = (id: string, kind: FieldSpec["kind"] = "text"): FieldSpec => ({ id, label: id, kind, required: false });

/** A form whose text box sits far below the fold and logs every key it gets, with when it got it. */
const FORM = `<div style="height:2000px"></div>
<input data-aa-id="name" id="name">
<input data-aa-id="noKeys" id="noKeys">
<textarea data-aa-id="essay" id="essay"></textarea>
<script>
  window.keys = [];
  document.getElementById("name").addEventListener("keydown", e => keys.push({ key: e.key, at: performance.now() }));
  // A box that ignores the keyboard: only a direct value set (fill) gets text into it.
  document.getElementById("noKeys").addEventListener("keydown", e => e.preventDefault());
</script>`;

test("production pacing is human but fast; the test suite runs with no delays", () => {
  expect(paceFromEnv({})).toEqual({ keyMs: [10, 35], fieldMs: [150, 400], actionMs: [80, 200] });
  expect(paceFromEnv({ AI_APPLIER_PACE: "off" })).toBe(NO_PACE);
  expect(currentPace()).toBe(NO_PACE);
  for (let i = 0; i < 50; i++) {
    const ms = pick(HUMAN_PACE.keyMs);
    expect(ms).toBeGreaterThanOrEqual(10);
    expect(ms).toBeLessThanOrEqual(35);
  }
  expect(pick(NO_PACE.fieldMs)).toBe(0);
});

test("text is typed key by key at the configured pace, after scrolling the field into view", async () => {
  await page.setContent(FORM);
  setPace(HUMAN_PACE);
  const started = Date.now();
  await fillField(page, field("name"), { type: "text", text: "Luis H" });
  const took = Date.now() - started;
  expect(await page.locator("#name").inputValue()).toBe("Luis H");
  const keys = (await page.evaluate("window.keys")) as { key: string; at: number }[];
  expect(keys.map(k => k.key).join("")).toBe("Luis H");
  const gaps = keys.slice(1).map((k, i) => k.at - keys[i]!.at);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
  // A field pause (≥150ms) plus six key delays (≥10ms each).
  expect(took).toBeGreaterThanOrEqual(150 + 60);
  expect(await page.locator("#name").evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
});

test("with no pace the same fill types instantly", async () => {
  await page.setContent(FORM);
  const started = Date.now();
  await fillField(page, field("name"), { type: "text", text: "Luis Hernandez" });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(await page.locator("#name").inputValue()).toBe("Luis Hernandez");
  expect(((await page.evaluate("window.keys")) as unknown[]).length).toBe(14);
});

test("a box typing can't fill falls back to fill; newlines never press Enter in a one-line box", async () => {
  await page.setContent(FORM);
  await fillField(page, field("noKeys"), { type: "text", text: "kept anyway" });
  expect(await page.locator("#noKeys").inputValue()).toBe("kept anyway");
  await page.setContent(`<form onsubmit="window.sent = true; return false"><input data-aa-id="one" id="one"></form>`);
  await fillField(page, field("one"), { type: "text", text: "line one\nline two" });
  expect(await page.locator("#one").inputValue()).toBe("line one line two");
  expect(await page.evaluate("window.sent")).toBeUndefined();
  await page.setContent(FORM);
  await fillField(page, field("essay", "textarea"), { type: "text", text: "a\nb" });
  expect(await page.locator("#essay").inputValue()).toBe("a\nb");
});
