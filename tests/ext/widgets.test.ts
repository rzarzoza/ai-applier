/**
 * The extension's custom-widget handling (extension/src/widgets.ts, fill.ts, refine.ts, sections.ts) against fixtures
 * that behave like the real ATS widgets: react-select (single, multi, async), Greenhouse's phone-country picker and
 * location geocoder, Lever's select2, Ashby's Yes/No pairs and resume parser, a Workday-like multi-step form, and a
 * SmartRecruiters-like shadow-DOM phone picker. Every check reads what the control shows, as a person would.
 */
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AdaptResponse, ExtAnswer, ExtHints } from "../../src/ext/protocol.js";
import type { FieldSpec } from "../../src/forms/types.js";
import type { AaTestApi } from "../../extension/src/testing.js";
import type { AdaptCall } from "../../extension/src/fill.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/forms/${name}`, import.meta.url), "utf8");
type Win = { __aa: AaTestApi; __values: Record<string, unknown>; __hostValues: Record<string, unknown>; __searches: Record<string, string[]>;
  __aaHints?: ExtHints; __aaAdapt?: (c: AdaptCall) => AdaptResponse | null; __aaAdaptCalls?: AdaptCall[]; __presses: number; __nextClicks: number };

const HINTS: ExtHints = { place: { city: "Houston", state: "Texas", country: "USA" }, inProgress: true };
let bundle: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const out = await build({
    entryPoints: [new URL("../../extension/src/testing.ts", import.meta.url).pathname],
    bundle: true, format: "iife", target: "chrome121", write: false, logLevel: "silent",
  });
  bundle = out.outputFiles[0]!.text;
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => { await browser.close(); });

/** Loads a fixture, waits for `ready` (late-rendering pages), injects the bundle and scans the form. */
async function load(name: string, ready?: string): Promise<FieldSpec[]> {
  await page.setContent(fixture(name));
  if (ready) await page.waitForSelector(ready, { state: "attached" });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(h => {
    const w = window as unknown as Win;
    w.__aaHints = h;
    delete w.__aaAdapt;
    w.__aaAdaptCalls = [];
  }, HINTS);
  return scan();
}
const scan = (min = 3) => page.evaluate(m => {
  const aa = (window as unknown as Win).__aa;
  return aa.collect(aa.scope(m, true)!);
}, min);
const fill = (field: FieldSpec, answer: ExtAnswer) =>
  page.evaluate(([f, a]) => (window as unknown as Win).__aa.fill(f, a), [field, answer] as const);
const read = (field: FieldSpec) => page.evaluate(f => (window as unknown as Win).__aa.read(f), field);
const values = () => page.evaluate(() => (window as unknown as Win).__values);
const by = (fields: FieldSpec[], label: string) => {
  const f = fields.find(x => x.label === label);
  if (!f) throw new Error(`no field "${label}" in ${fields.map(x => x.label).join(" | ")}`);
  return f;
};
const text = (t: string): ExtAnswer => ({ type: "text", text: t });

test("Greenhouse react-select: phone country, geocoder, yes/no, multi-select and async education searches", async () => {
  const fields = await load("react-select.html");
  expect(fields.map(f => [f.label, f.kind, f.required])).toEqual([
    ["First Name", "text", true], ["Email", "text", true], ["Country", "combobox", true], ["Phone", "tel", false],
    ["Location (City)", "combobox", true], ["Will you now or in the future require sponsorship?", "combobox", true],
    ["Which languages do you speak?", "combobox", false], ["School", "combobox", true], ["Degree", "combobox", true],
    ["Discipline", "combobox", false], ["Gender", "combobox", false],
  ]);

  // "USA" is the picker's "United States +1" (the list shows it only as that).
  expect(await fill(by(fields, "Country"), text("USA"))).toMatchObject({ ok: true, value: "United States +1" });
  // A bare "Houston" is looked up as the profile's "Houston, Texas", and only Houston in Texas is taken.
  expect(await fill(by(fields, "Location (City)"), text("Houston"))).toMatchObject({ ok: true, value: "Houston, Texas, United States" });
  expect(await page.evaluate(() => (window as unknown as Win).__searches["candidate-location"]?.[0])).toBe("Houston, Texas");
  expect(await fill(by(fields, "Will you now or in the future require sponsorship?"), { type: "option", option: "No" })).toMatchObject({ ok: true, value: "No" });
  expect(await fill(by(fields, "Which languages do you speak?"), text("English, Spanish"))).toMatchObject({ ok: true, value: ["English", "Spanish"] });
  expect(await fill(by(fields, "School"), text("Rice University"))).toMatchObject({ ok: true, value: "Rice University" });
  // "B.S." isn't in the list: searched as "Bachelor" and mapped by level.
  expect(await fill(by(fields, "Degree"), text("B.S."))).toMatchObject({ ok: true, value: "Bachelor's Degree" });
  expect(await fill(by(fields, "Discipline"), text("Computer Science"))).toMatchObject({ ok: true, value: "Computer Science" });
  expect(await fill(by(fields, "Gender"), { type: "option", option: "Male" })).toMatchObject({ ok: true, value: "Male" });
  expect(await values()).toEqual({
    country: "United States +1", "candidate-location": "Houston, Texas, United States", question_1: "No", question_2: ["English", "Spanish"],
    "school--0": "Rice University", "degree--0": "Bachelor's Degree", "discipline--0": "Computer Science", gender: "Male",
  });
  // Each picker shows its value in place of the placeholder, and no typed text is left behind.
  expect(await page.locator(".select__single-value").allInnerTexts()).toEqual([
    "United States +1", "Houston, Texas, United States", "No", "Rice University", "Bachelor's Degree", "Computer Science", "Male",
  ]);
  expect(await page.locator("input.select__input").evaluateAll(els => els.map(e => (e as HTMLInputElement).value).join(""))).toBe("");
  expect(await page.locator("[role=listbox]").count()).toBe(0);
});

test("a phone picker's '+1' is the United States, and a failed pick says why with options to choose from", async () => {
  const fields = await load("react-select.html");
  expect(await fill(by(fields, "Country"), text("+1"))).toMatchObject({ ok: true, value: "United States +1" });
  const out = await fill(by(fields, "Gender"), text("Nonbinary"));
  expect(out).toMatchObject({ ok: false, error: 'No option for "Nonbinary" — options: Male, Female, Decline To Self Identify', choices: ["Male", "Female", "Decline To Self Identify"] });
  // The app was asked with exactly the options the list showed.
  expect(await page.evaluate(() => (window as unknown as Win).__aaAdaptCalls?.map(c => [c.value, c.options, c.final])))
    .toEqual([["Nonbinary", ["Male", "Female", "Decline To Self Identify"], false]]);
  expect(await read(by(fields, "Gender"))).toBe("");
  // A place the geocoder doesn't know in that state is never guessed.
  const loc = await fill(by(fields, "Location (City)"), text("Springfield, Texas"));
  expect(loc).toMatchObject({ ok: false });
  expect((loc as { error: string }).error).toMatch(/^No option for "Springfield, Texas" in that city and state/);
  expect(await page.locator(".select__single-value").allInnerTexts()).toEqual(["United States +1"]);
});

test("a name an async list lacks: the app's other spellings are searched, then its Other is picked and reported", async () => {
  const fields = await load("react-select.html");
  await page.evaluate(() => {
    (window as unknown as Win).__aaAdapt = c => (c.final
      ? (c.options.includes("Other") ? { answer: { type: "option", option: "Other" }, other: String(c.value), otherAllowed: true } : { answer: null, otherAllowed: true })
      : { answer: null, otherAllowed: true, variants: ["Rice Institute"] });
  });
  const out = await fill(by(fields, "School"), text("William Marsh Rice Institute of Technology"));
  expect(out).toEqual({ ok: true, value: "Other", other: "William Marsh Rice Institute of Technology" });
  const calls = await page.evaluate(() => (window as unknown as Win).__aaAdaptCalls!.map(c => ({ final: c.final, other: c.options.includes("Other") })));
  expect(calls).toEqual([{ final: false, other: false }, { final: true, other: true }]);
  const searched = await page.evaluate(() => (window as unknown as Win).__searches["school--0"]);
  expect(searched).toEqual(expect.arrayContaining(["William Marsh Rice Institute of Technology", "Rice Institute", "Other"]));
});

test("Lever: select2 university search, cards radios, EEO selects, and the plain-text location", async () => {
  const fields = await load("lever-select2.html");
  expect(fields.map(f => [f.label, f.kind, f.required])).toEqual([
    ["Full name", "text", true], ["Email", "email", true], ["Current location", "text", true], ["University", "combobox", true],
    ["Are you authorized to work in the US?", "radio", true], ["Gender", "select", false], ["Veteran status", "select", false],
  ]);
  expect(await fill(by(fields, "University"), text("Rice University"))).toMatchObject({ ok: true, value: "Rice University" });
  expect(await page.inputValue("select.select2-hidden-accessible")).toBe("Rice University");
  expect(await page.textContent(".select2-selection__rendered")).toBe("Rice University");
  expect(await page.locator(".select2-container--open").count()).toBe(0);
  expect(await fill(by(fields, "Current location"), text("Houston, Texas"))).toMatchObject({ ok: true, value: "Houston, Texas" });
  expect(await fill(by(fields, "Are you authorized to work in the US?"), { type: "option", option: "Yes" })).toMatchObject({ ok: true, value: "Yes" });
  expect(await fill(by(fields, "Gender"), { type: "option", option: "Male" })).toMatchObject({ ok: true, value: "Male" });
  // "I am not a protected veteran" isn't an option: the app maps it (here: the stub names the option).
  await page.evaluate(() => { (window as unknown as Win).__aaAdapt = () => ({ answer: { type: "option", option: "I am not a veteran" }, otherAllowed: false }); });
  expect(await fill(by(fields, "Veteran status"), text("I am not a protected veteran"))).toMatchObject({ ok: true, value: "I am not a veteran" });
  // A university the list lacks fails and offers what it found.
  const out = await fill(by(fields, "University"), text("Rice"));
  expect(out).toMatchObject({ ok: false, choices: ["Rice University", "Rice University (Jones Graduate School)"] });
});

test("Ashby: Yes/No pairs are questions (pressed only when not already), the autofill widget is not a field", async () => {
  const fields = await load("ashby-like.html");
  expect(fields.map(f => [f.label, f.kind, f.required])).toEqual([
    ["Name", "text", true], ["Email", "email", true], ["Resume", "file", true], ["Location", "combobox", true],
    ["Are you legally authorized to work in the United States?", "radio", true], ["Will you now or in the future require visa sponsorship?", "radio", false],
  ]);
  const auth = by(fields, "Are you legally authorized to work in the United States?");
  expect(auth.options).toEqual(["Yes", "No"]);
  expect(await fill(auth, { type: "option", option: "Yes" })).toMatchObject({ ok: true, value: "Yes" });
  expect(await fill(auth, { type: "option", option: "Yes" })).toMatchObject({ ok: true, value: "Yes" });
  // Already "No": never pressed again (that would clear it).
  expect(await fill(by(fields, "Will you now or in the future require visa sponsorship?"), { type: "option", option: "No" })).toMatchObject({ ok: true, value: "No" });
  expect(await page.evaluate(() => (window as unknown as Win).__presses)).toBe(1);
  expect(await fill(by(fields, "Location"), text("Houston"))).toMatchObject({ ok: true, value: "Houston, Texas, United States" });
  expect(await values()).toMatchObject({ q_auth: "Yes", q_sponsor: "No", location: "Houston, Texas, United States" });
  // The resume upload starts Ashby's parser; the extension can tell it's running.
  expect(await page.evaluate(() => (window as unknown as Win).__aa.parsing())).toBe(false);
  expect(await fill(by(fields, "Resume"), { type: "file", resume: true })).toMatchObject({ ok: true });
  await page.waitForFunction(() => (window as unknown as Win).__aa.parsing(), undefined, { timeout: 3000 });
  expect(await values()).not.toHaveProperty("autofillUsed");
});

test("Workday: dropdown buttons, the multiselect prompt and radios on each step; Next and Add are never clicked", async () => {
  let fields = await load("workday-like.html", "#input-1");
  expect(fields.map(f => [f.label, f.kind, f.required])).toEqual([
    ["First Name", "text", true], ["Country", "combobox", true], ["How Did You Hear About Us?", "combobox", true],
    ["Have you previously worked for Mini?", "radio", true], ["Phone Number", "text", false],
  ]);
  expect(await fill(by(fields, "First Name"), text("Luis"))).toMatchObject({ ok: true, value: "Luis" });
  expect(await fill(by(fields, "Country"), text("USA"))).toMatchObject({ ok: true, value: "United States of America" });
  expect(await fill(by(fields, "How Did You Hear About Us?"), text("LinkedIn"))).toMatchObject({ ok: true, value: "LinkedIn" });
  expect(await fill(by(fields, "Have you previously worked for Mini?"), { type: "option", option: "No" })).toMatchObject({ ok: true, value: "No" });
  expect(await values()).toEqual({ legalNameSection_firstName: "Luis", countryDropdown: "United States of America", source: ["LinkedIn"], previousWorker: "false" });
  expect(await page.textContent("#input-2")).toBe("United States of America");
  expect(await page.locator("[data-automation-id=activeListContainer]").count()).toBe(0);

  // The user moves on; the next step's fields are new.
  await page.click("#next");
  await page.waitForSelector("#input-11");
  // A step with only two questions (the extension takes any size of form on Workday).
  fields = await scan(1);
  expect(fields.map(f => [f.label, f.kind])).toEqual([
    ["Are you legally authorized to work in the United States?", "combobox"], ["Will you now or in the future require sponsorship?", "combobox"],
  ]);
  expect(await fill(by(fields, "Are you legally authorized to work in the United States?"), { type: "option", option: "Yes" })).toMatchObject({ ok: true, value: "Yes" });
  expect(await fill(by(fields, "Will you now or in the future require sponsorship?"), { type: "option", option: "No" })).toMatchObject({ ok: true, value: "No" });
  expect(await page.evaluate(() => (window as unknown as Win).__aa.manual())).toEqual(["Work Experience"]);
  expect(await page.evaluate(() => (window as unknown as Win).__nextClicks)).toBe(1);
  expect(await values()).not.toHaveProperty("addClicked");
});

test("SmartRecruiters: a shadow-DOM phone country picker, and Experience / Education left to add by hand", async () => {
  const fields = await load("sr-phone.html", "spl-country-picker");
  await page.waitForFunction(() => !!document.querySelector("spl-country-picker")?.shadowRoot);
  const all = await scan();
  const code = by(all.length ? all : fields, "Country code");
  expect(code.kind).toBe("combobox");
  expect(await fill(code, text("USA"))).toMatchObject({ ok: true, value: "United States (+1)" });
  expect(await fill(code, text("+52"))).toMatchObject({ ok: true, value: "Mexico (+52)" });
  expect(await fill(code, text("+1"))).toMatchObject({ ok: true, value: "United States (+1)" });
  expect(await page.evaluate(() => (window as unknown as Win).__hostValues.code)).toBe("United States (+1)");
  expect(await page.evaluate(() => (window as unknown as Win).__aa.manual())).toEqual(["Experience", "Education"]);
  expect(await page.evaluate(() => (window as unknown as Win).__hostValues.addClicked)).toBeUndefined();
});
