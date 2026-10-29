import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ExtAnswer } from "../../src/ext/protocol.js";
import type { FieldSpec } from "../../src/forms/types.js";
import type { AaTestApi } from "../../extension/src/testing.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/forms/${name}`, import.meta.url), "utf8");
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

async function load(html: string): Promise<FieldSpec[]> {
  await page.setContent(html);
  await page.addScriptTag({ content: bundle });
  return page.evaluate(() => {
    const aa = (window as unknown as { __aa: AaTestApi }).__aa;
    return aa.collect(aa.scope(3, true)!);
  });
}

const fill = (field: FieldSpec, answer: ExtAnswer) =>
  page.evaluate(([f, a]) => (window as unknown as { __aa: AaTestApi }).__aa.fill(f, a), [field, answer] as const);
const byLabel = (fields: FieldSpec[], label: string) => {
  const f = fields.find(x => x.label === label);
  if (!f) throw new Error(`no field "${label}" in ${fields.map(x => x.label).join(", ")}`);
  return f;
};

test("the extension's scan sees the same fields as the runner's", async () => {
  const fields = await load(fixture("basic.html"));
  expect(fields.map(f => [f.label, f.kind])).toEqual([
    ["First Name", "text"], ["Email", "email"], ["LinkedIn Profile", "url"], ["Phone", "tel"], ["Why us?", "textarea"], ["Degree", "select"],
    ["Are you authorized to work in the US?", "radio"], ["I certify the above is accurate", "checkbox"], ["I agree to receive SMS updates", "checkbox"],
    ["Which languages?", "checkbox-group"], ["Resume", "file"], ["School", "combobox"], ["Department", "combobox"],
  ]);
});

test("fills every kind of control on the basic form", async () => {
  const fields = await load(fixture("basic.html"));
  const answers: [string, ExtAnswer][] = [
    ["First Name", { type: "text", text: "Luis" }],
    ["Email", { type: "text", text: "luis@example.com" }],
    ["Why us?", { type: "text", text: "Line one\nLine two" }],
    ["Degree", { type: "option", option: "master's" }],
    ["Are you authorized to work in the US?", { type: "option", option: "Yes" }],
    ["I certify the above is accurate", { type: "check", checked: true }],
    ["Which languages?", { type: "options", options: ["English", "Spanish"] }],
    ["Resume", { type: "file", resume: true }],
    ["School", { type: "option", option: "Stanford University" }],
    ["Department", { type: "option", option: "Data" }],
  ];
  for (const [label, answer] of answers) {
    const out = await fill(byLabel(fields, label), answer);
    expect(out, label).toMatchObject({ ok: true });
  }
  expect(await page.inputValue("#fn")).toBe("Luis");
  expect(await page.inputValue("input[name=email]")).toBe("luis@example.com");
  expect(await page.inputValue("#why")).toBe("Line one\nLine two");
  expect(await page.inputValue("#deg")).toBe("m");
  expect(await page.isChecked("input[name=auth][value=y]")).toBe(true);
  expect(await page.isChecked("input[name=certify]")).toBe(true);
  expect(await page.isChecked("input[name=lang][value=en]")).toBe(true);
  expect(await page.isChecked("input[name=lang][value=es]")).toBe(true);
  expect(await page.isChecked("input[name=lang][value=fr]")).toBe(false);
  expect(await page.evaluate(() => Array.from((document.getElementById("cv") as HTMLInputElement).files!).map(f => f.name))).toEqual(["Luis_Hernandez_Resume.pdf"]);
  expect(await page.inputValue("#school")).toBe("Stanford University");
  // "Data" is the start of exactly one option.
  expect(await page.textContent("#dept")).toBe("Data Science");
});

test("a combobox with no matching option is left empty and reported", async () => {
  const fields = await load(fixture("basic.html"));
  const out = await fill(byLabel(fields, "School"), { type: "option", option: "University of Texas" });
  // Two options start with it: not unique, so nothing is picked.
  expect(out).toEqual({ ok: false, error: 'No option matching "University of Texas"' });
  expect(await page.inputValue("#school")).toBe("");
  expect(await fill(byLabel(fields, "Degree"), { type: "option", option: "PhD" })).toMatchObject({ ok: false });
});

test("values stick in React-style controlled inputs (a plain value assignment would be reverted)", async () => {
  const fields = await load(fixture("react-controlled.html"));
  // The fixture is faithful: assigning .value and firing input is ignored and undone on blur.
  await page.evaluate(() => {
    const el = document.getElementById("name") as HTMLInputElement;
    el.value = "naive";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("blur"));
  });
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => (window as unknown as { __state: Record<string, string> }).__state.name)).toBe("");
  expect(await page.inputValue("#name")).toBe("");

  for (const [label, answer] of [
    ["Full name", { type: "text", text: "Luis Hernandez" }], ["Email", { type: "text", text: "luis@example.com" }],
    ["About you", { type: "text", text: "Builder." }], ["Country", { type: "option", option: "Mexico" }],
  ] as [string, ExtAnswer][]) expect(await fill(byLabel(fields, label), answer), label).toMatchObject({ ok: true });
  await page.waitForTimeout(20);
  expect(await page.evaluate(() => (window as unknown as { __state: Record<string, string> }).__state))
    .toEqual({ name: "Luis Hernandez", mail: "luis@example.com", about: "Builder.", country: "mx" });
  expect(await page.inputValue("#name")).toBe("Luis Hernandez");
  expect(await page.inputValue("#country")).toBe("mx");
});

test("fills the mini ATS form, and never a password box", async () => {
  const fields = await load(fixture("mini-ats.html"));
  expect(fields.map(f => f.label)).toEqual([
    "First Name", "Email", "Phone", "Are you willing to relocate?", "Tell us about a project you are proud of",
    "I certify that the information above is accurate", "Text me about new roles",
  ]);
  expect(await fill(byLabel(fields, "Phone"), { type: "text", text: "5551234567" })).toMatchObject({ ok: true, value: "5551234567" });
  expect(await fill(byLabel(fields, "Are you willing to relocate?"), { type: "option", option: "Yes" })).toMatchObject({ ok: true, value: "Yes" });
  expect(await page.inputValue("#reloc")).toBe("y");

  await page.setContent(`<form><label for="u">User</label><input id="u"><label for="p">Password</label><input id="p" type="password"></form>`);
  await page.addScriptTag({ content: bundle });
  const pw = await page.evaluate(() => {
    const aa = (window as unknown as { __aa: AaTestApi }).__aa;
    return aa.collect("form");
  });
  const out = await fill(byLabel(pw, "Password"), { type: "text", text: "secret" });
  expect(out).toEqual({ ok: false, error: "Password fields are never filled" });
  expect(await page.inputValue("#p")).toBe("");
  // A form asking for a password (sign-in, account creation) is never taken as the application.
  expect(await page.evaluate(() => (window as unknown as { __aa: AaTestApi }).__aa.scope(1, false))).toBeNull();
});

test("the application form is picked over a site search box, and only known ATS pages wake the extension", async () => {
  await page.setContent(`<header><form role="search"><input aria-label="Search" name="q"><input name="a"><input name="b"></form></header>
    <form id="apply"><label>A <input></label><label>B <input></label><label>C <input></label><label>D <input></label></form>`);
  await page.addScriptTag({ content: bundle });
  expect(await page.evaluate(() => {
    (window as unknown as { __aa: AaTestApi }).__aa.scope();
    return document.querySelector("[data-aa-scope]")?.id;
  })).toBe("apply");
  const urls: [string, boolean][] = [
    ["https://job-boards.greenhouse.io/acme/jobs/1", true], ["https://boards.greenhouse.io/embed/job_app?for=acme&token=1", true],
    ["https://jobs.lever.co/acme/x/apply", true], ["https://jobs.ashbyhq.com/acme/x/application", true],
    ["https://acme.wd1.myworkdayjobs.com/en-US/External/job/X_R1/apply", true],
    ["https://ejta.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1", true], ["https://ejta.fa.us2.oraclecloud.com/other", false],
    ["https://jobs.smartrecruiters.com/Acme/1", true], ["https://careers-acme.icims.com/jobs/1/job", true],
    ["https://acme.bamboohr.com/careers/12", true], ["https://acme.bamboohr.com/login", false], ["https://apply.workable.com/acme/j/ABC/apply", true],
    ["https://acme.com/careers?gh_jid=123", true], ["https://www.google.com/search?q=jobs", false], ["https://github.com/login", false],
  ];
  for (const [url, want] of urls) expect(await page.evaluate(u => (window as unknown as { __aa: AaTestApi }).__aa.isApplicationPage(u), url), url).toBe(want);
});
