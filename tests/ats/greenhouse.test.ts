import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { greenhouse } from "../../src/ats/greenhouse.js";
import { inPage } from "../../src/forms/in-page.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/greenhouse/${name}.html`, import.meta.url), "utf8");
const jobBoards = fixture("job-boards");
const legacy = fixture("boards-legacy");

let browser: Browser;
let context: BrowserContext;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });
beforeEach(async () => {
  await context?.close();
  context = await browser.newContext();
  // Fixtures are inert snapshots; nothing may reach the network.
  await context.route("**/*", r => r.abort());
  page = await context.newPage();
});

/** Serves `html` at `url` (offline) so navigation-based code paths can run. */
const serve = (url: string, html: string, status = 200) =>
  context.route(url, r => r.fulfill({ status, contentType: "text/html", body: html }));

test("greenhouse fixture: core fields extracted", async () => {
  for (const fx of [jobBoards, legacy]) {
    await page.setContent(fx);
    const labels = (await greenhouse.readFields(page)).map(f => f.label.toLowerCase());
    for (const l of ["first name", "last name", "email", "resume"]) expect(labels.some(x => x.includes(l)), l).toBe(true);
  }
});

test("greenhouse fixture: kinds, required flags, upload labels, async comboboxes", async () => {
  await page.setContent(legacy);
  const fields = await greenhouse.readFields(page);
  const by = (label: string) => fields.find(f => f.label === label);
  expect(by("First Name")).toMatchObject({ kind: "text", required: true });
  expect(by("Preferred First Name")).toMatchObject({ kind: "text", required: false });
  expect(by("Phone")).toMatchObject({ kind: "tel", required: true });
  expect(by("Country")).toMatchObject({ kind: "combobox", required: true });
  expect(by("Resume/CV")).toMatchObject({ kind: "file", required: true });
  expect(by("Please provide a recent transcript of your PhD studies (if applicable)")).toMatchObject({ kind: "file", required: false });
  expect(by("End date year")).toMatchObject({ kind: "number", required: true });
  for (const l of ["School", "Degree", "Location (City)"]) {
    expect(by(l), l).toMatchObject({ kind: "combobox", required: true });
    expect(by(l)!.options, l).toBeUndefined();
  }
  expect(fields.find(f => f.label.startsWith("Please choose the single location"))).toMatchObject({
    kind: "checkbox-group", required: true, options: ["Mountain View, CA", "San Francisco, CA", "Bellevue, WA", "Vancouver, Canada"],
  });
  // react-select's hidden "required" mirror inputs and the closed phone-country search box are not fields
  expect(fields.filter(f => f.kind === "text").map(f => f.label)).toEqual(
    ["First Name", "Last Name", "Preferred First Name", "Email", "LinkedIn Profile", "Website", "How did you hear about this job?"]);
  expect(fields.some(f => f.label === "Attach" || f.label === "Search")).toBe(false);
  expect(fields.some(f => f.description === "Select...")).toBe(false);
});

test("greenhouse outcome: a fresh form is pending", async () => {
  await page.setContent(jobBoards);
  expect(await greenhouse.outcome(page)).toEqual({ kind: "pending" });
});

test("greenhouse outcome detects confirmation and validation errors", async () => {
  await page.setContent("<main><h1>Thank you for applying.</h1><p>Your application has been received.</p></main>");
  expect(await greenhouse.outcome(page)).toEqual({ kind: "submitted" });
  await page.setContent("<main><p>Application submitted!</p></main>");
  expect(await greenhouse.outcome(page)).toEqual({ kind: "submitted" });

  await page.setContent(`<form id="application-form">
    <label id="first_name-label" for="first_name" class="label label--error">First Name<span>*</span></label>
    <input id="first_name" aria-invalid="true" aria-errormessage="first_name-error">
    <p id="first_name-error" class="helper-text helper-text--error">This field is required.</p>
    <div role="group" aria-labelledby="upload-label-resume"><div id="upload-label-resume" class="label upload-label upload-label--error">Resume/CV<span>*</span></div>
      <p id="resume-error" class="helper-text helper-text--error">This field is required.</p></div>
    <p class="helper-text--error" style="display:none">Hidden error</p>
    <div class="grecaptcha-error"></div>
    <button type="submit">Submit application</button></form>`);
  expect(await greenhouse.outcome(page)).toEqual({
    kind: "validation-error", messages: ["First Name: This field is required.", "Resume/CV: This field is required."],
  });

  await serve("https://job-boards.greenhouse.io/acme/jobs/1/confirmation", "<html><body><h1>Done</h1></body></html>");
  await page.goto("https://job-boards.greenhouse.io/acme/jobs/1/confirmation");
  expect(await greenhouse.outcome(page)).toEqual({ kind: "submitted" });
});

test("greenhouse outcome detects captcha and verification code", async () => {
  await page.setContent(`<form id="application-form"><input id="first_name"></form>
    <iframe title="recaptcha challenge expires in two minutes" src="https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x" width="400" height="580"></iframe>`);
  expect(await greenhouse.outcome(page)).toEqual({ kind: "captcha" });
  await page.setContent(`<iframe title="Main content of the hCaptcha challenge" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html" width="400" height="580"></iframe>`);
  expect(await greenhouse.outcome(page)).toEqual({ kind: "captcha" });
  // the invisible reCAPTCHA anchor present on every form is not a challenge
  await page.setContent(`<form id="application-form"><input id="first_name"></form>
    <iframe title="reCAPTCHA" src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible" width="256" height="60"></iframe>
    <iframe title="recaptcha challenge expires in two minutes" src="https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x" style="visibility:hidden"></iframe>`);
  expect(await greenhouse.outcome(page)).toEqual({ kind: "pending" });

  await page.setContent(`<form id="application-form"><fieldset id="email-verification">
    <legend>A verification code was sent to t***@example.com. Enter the 8-character security code to confirm you're a human.</legend>
    ${Array.from({ length: 8 }, (_, i) => `<input id="security-input-${i}" maxlength="1">`).join("")}</fieldset></form>`);
  expect(await greenhouse.outcome(page)).toEqual({ kind: "verification-code" });
});

test("greenhouse readBack reads react-select values and uploaded file names", async () => {
  await page.setContent(legacy);
  const fields = await greenhouse.readFields(page);
  const school = fields.find(f => f.label === "School")!;
  const resume = fields.find(f => f.label === "Resume/CV")!;
  expect(await greenhouse.readBack(page, school)).toBeNull();
  expect(await greenhouse.readBack(page, resume)).toBeNull();
  // What React renders after a pick / an upload (the file input is replaced by the file name)
  await page.evaluate(inPage(() => {
    const input = document.getElementById("school--0")!;
    const single = document.createElement("div");
    single.className = "select__single-value";
    single.textContent = "Stanford University";
    input.closest(".select__value-container")!.prepend(single);
    const group = document.querySelector('[aria-labelledby="upload-label-resume"]')!;
    group.querySelector(".file-upload__wrapper")!.innerHTML =
      '<div class="file-upload__filename"><p class="body body__secondary">resume-sample.pdf</p><button aria-label="Remove file"></button></div>';
  }));
  expect(await greenhouse.readBack(page, school)).toBe("Stanford University");
  expect(await greenhouse.readBack(page, resume)).toBe("resume-sample.pdf");
  const first = fields.find(f => f.label === "First Name")!;
  await greenhouse.fill(page, first, { type: "text", text: "Ada" });
  expect(await greenhouse.readBack(page, first)).toBe("Ada");
});

test("greenhouse description: job text when shown, undefined on the bare embed", async () => {
  await page.setContent(jobBoards);
  const d = await greenhouse.description(page);
  expect(d).toMatch(/Undergraduate Software Engineering intern/);
  expect(d!.length).toBeLessThanOrEqual(8000);
  expect(d).toBe(d!.trim());
  await page.setContent(legacy);
  expect(await greenhouse.description(page)).toBeUndefined();
});

test("greenhouse submit clicks the Submit application button", async () => {
  await page.setContent(`<form id="application-form" onsubmit="event.preventDefault(); document.body.dataset.sent = 'yes'">
    <a href="#application-form">Apply</a><input id="first_name"><button type="submit">Submit application</button></form>`);
  await greenhouse.submit(page);
  expect(await page.locator("body").getAttribute("data-sent")).toBe("yes");
});

test("greenhouse open: form page ok, closed posting, company page with embed, missing board", async () => {
  const form = `<html><body><h1>Intern</h1><form id="application-form"><input id="first_name"></form></body></html>`;
  await serve("https://job-boards.greenhouse.io/acme/jobs/1", form);
  expect(await greenhouse.open(page, "https://job-boards.greenhouse.io/acme/jobs/1")).toEqual({ ok: true });

  await serve("https://job-boards.greenhouse.io/acme/jobs/2", "<p>The job you are looking for is no longer open.</p>");
  expect(await greenhouse.open(page, "https://job-boards.greenhouse.io/acme/jobs/2")).toMatchObject({ ok: false, reason: "closed" });

  await serve("https://careers.acme.com/jobs?gh_jid=3", `<h1>Acme careers</h1>
    <iframe src="https://job-boards.greenhouse.io/embed/job_app?for=acme&token=3"></iframe>`);
  await serve("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=3", form);
  expect(await greenhouse.open(page, "https://careers.acme.com/jobs?gh_jid=3")).toEqual({ ok: true });
  expect(page.url()).toBe("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=3");

  await serve("https://job-boards.greenhouse.io/gone/jobs/4", "<p>Page not found</p>", 404);
  expect(await greenhouse.open(page, "https://job-boards.greenhouse.io/gone/jobs/4")).toMatchObject({ ok: false, reason: "not-found" });

  await serve("https://careers.acme.com/jobs?gh_jid=5", "<h1>Acme</h1><p>Our own form lives elsewhere.</p>");
  expect(await greenhouse.open(page, "https://careers.acme.com/jobs?gh_jid=5")).toMatchObject({ ok: false, reason: "closed" });
});

test("greenhouse open reveals a form hidden behind an Apply button", async () => {
  await serve("https://job-boards.greenhouse.io/acme/jobs/6", `<html><body>
    <button type="button" onclick="document.getElementById('application-form').hidden = false">Apply for this job</button>
    <form id="application-form" hidden><input id="first_name"><button type="submit">Submit application</button></form></body></html>`);
  expect(await greenhouse.open(page, "https://job-boards.greenhouse.io/acme/jobs/6")).toEqual({ ok: true });
});

test("greenhouse root is the embedded frame when the form lives in a greenhouse iframe", async () => {
  await serve("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=7", legacy);
  await serve("https://careers.acme.com/jobs?gh_jid=7", `<iframe src="https://job-boards.greenhouse.io/embed/job_app?for=acme&token=7" width="900" height="2000"></iframe>`);
  await page.goto("https://careers.acme.com/jobs?gh_jid=7");
  const root = await greenhouse.root(page);
  expect(root).not.toBe(page);
  expect(root.url()).toContain("job-boards.greenhouse.io/embed/job_app");
  const labels = (await greenhouse.readFields(page)).map(f => f.label);
  expect(labels).toContain("First Name");
});
