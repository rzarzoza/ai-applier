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

test("greenhouse outcome ignores thank-you and security-code wording in the job description", async () => {
  const describe = (text: string) => page.evaluate(inPage((t: string) => {
    const p = document.createElement("p");
    p.textContent = t;
    document.querySelector(".job__description")!.prepend(p);
  }), text);
  await page.setContent(jobBoards);
  await describe("Thank you for applying! Once your application has been received, we will reach out.");
  expect(await greenhouse.outcome(page)).toEqual({ kind: "pending" });
  await describe("You will lead security code reviews and verification code audits.");
  expect(await greenhouse.outcome(page)).toEqual({ kind: "pending" });

  await page.evaluate(inPage(() => {
    document.getElementById("first_name")!.insertAdjacentHTML("afterend",
      '<p id="first_name-error" class="helper-text helper-text--error">This field is required.</p>');
  }));
  expect(await greenhouse.outcome(page)).toEqual({ kind: "validation-error", messages: ["First Name: This field is required."] });

  // even with the form hidden, description text is not a confirmation
  await page.evaluate(inPage(() => { (document.getElementById("application-form") as HTMLElement).style.display = "none"; }));
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
  await serve("https://job-boards.greenhouse.io/confirmationco/jobs/1", `<form id="application-form"><input id="first_name"></form>`);
  await page.goto("https://job-boards.greenhouse.io/confirmationco/jobs/1");
  expect(await greenhouse.outcome(page)).toEqual({ kind: "pending" });
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
});

test("greenhouse open: bot walls and company-owned forms are blocked; a redirect off Greenhouse is closed", async () => {
  await serve("https://careers.acme.com/jobs?gh_jid=5", "<h1>Acme</h1><p>Our own form lives elsewhere.</p>");
  expect(await greenhouse.open(page, "https://careers.acme.com/jobs?gh_jid=5")).toMatchObject({ ok: false, reason: "blocked" });

  await serve("https://www.epic.example/careers/jobs/6?gh_jid=6",
    "<title>Just a moment...</title><p>One more step. Please complete a security check to continue</p>", 403);
  expect(await greenhouse.open(page, "https://www.epic.example/careers/jobs/6?gh_jid=6")).toMatchObject({ ok: false, reason: "blocked" });

  // Greenhouse sends a posting that is gone to the company's own careers page
  await serve("https://boards.greenhouse.io/acme/jobs/7", `<meta http-equiv="refresh" content="0;url=https://careers.acme.com/open-roles">`);
  await serve("https://careers.acme.com/open-roles", "<h1>Open roles</h1><a href='/x'>Apply</a>");
  expect(await greenhouse.open(page, "https://boards.greenhouse.io/acme/jobs/7")).toMatchObject({ ok: false, reason: "closed" });
}, 60000);

test("greenhouse open reveals a form hidden behind an Apply button", async () => {
  await serve("https://job-boards.greenhouse.io/acme/jobs/6", `<html><body>
    <button type="button" onclick="document.getElementById('application-form').hidden = false">Apply for this job</button>
    <form id="application-form" hidden><input id="first_name"><button type="submit">Submit application</button></form></body></html>`);
  expect(await greenhouse.open(page, "https://job-boards.greenhouse.io/acme/jobs/6")).toEqual({ ok: true });
});

test("greenhouse open never clicks a submit-type or in-form Apply control", async () => {
  await serve("https://job-boards.greenhouse.io/acme/jobs/8", `<html><body>
    <form id="other" onsubmit="event.preventDefault(); document.body.dataset.sent = 'yes'">
      <button type="submit">Apply</button><button>Apply now</button></form>
    <a href="#" type="submit" onclick="document.body.dataset.sent = 'link'">Apply</a>
    <form id="application-form" hidden><input id="first_name"></form></body></html>`);
  const r = await greenhouse.open(page, "https://job-boards.greenhouse.io/acme/jobs/8");
  expect(r).toMatchObject({ ok: false });
  expect(await page.locator("body").getAttribute("data-sent")).toBeNull();

  // and never on a company's own page, even when the Apply button is harmless
  await serve("https://careers.acme.com/jobs?gh_jid=9", `<button type="button" onclick="document.body.dataset.sent = 'yes'">Apply</button>`);
  expect(await greenhouse.open(page, "https://careers.acme.com/jobs?gh_jid=9")).toMatchObject({ ok: false, reason: "blocked" });
  expect(await page.locator("body").getAttribute("data-sent")).toBeNull();
});

/** A minimal react-select stand-in: typing renders the filtered options in the listbox named by aria-controls. */
const fakeSelect = (options: string[]) => `
  <div role="listbox" id="decoy"><div role="option" onclick="document.body.dataset.decoy = 'yes'">${options[0]}</div></div>
  <form id="application-form"><div class="select"><label id="s-label" for="s">School</label>
    <div class="select-shell"><div class="select__value-container"><input id="s" role="combobox" aria-labelledby="s-label"></div></div></div></form>
  <script>(() => {
    const options = ${JSON.stringify(options)};
    const input = document.getElementById("s");
    const shell = input.closest(".select-shell");
    input.addEventListener("input", () => {
      shell.querySelector("[role=listbox]")?.remove();
      const box = document.createElement("div");
      box.setAttribute("role", "listbox");
      box.id = "s-listbox";
      for (const o of options.filter(o => o.toLowerCase().includes(input.value.toLowerCase()))) {
        const el = document.createElement("div");
        el.setAttribute("role", "option");
        el.textContent = o;
        el.addEventListener("click", () => {
          box.remove();
          input.removeAttribute("aria-controls");
          input.value = "";
          const v = document.createElement("div");
          v.className = "select__single-value";
          v.textContent = o;
          shell.querySelector(".select__value-container").prepend(v);
        });
        box.appendChild(el);
      }
      shell.appendChild(box);
      input.setAttribute("aria-controls", box.id);
    });
  })();</script>`;

test("greenhouse fill picks from the field's own listbox: exact, else a unique prefix", async () => {
  await page.setContent(fakeSelect(["Stanford University", "Stanford Online High School", "University of Michigan"]));
  const school = (await greenhouse.readFields(page)).find(f => f.label === "School")!;
  await greenhouse.fill(page, school, { type: "text", text: "Stanford University" });
  expect(await greenhouse.readBack(page, school)).toBe("Stanford University");
  expect(await page.locator("body").getAttribute("data-decoy")).toBeNull();

  await page.setContent(fakeSelect(["University of Michigan - Dearborn", "Michigan State University"]));
  const s2 = (await greenhouse.readFields(page)).find(f => f.label === "School")!;
  await greenhouse.fill(page, s2, { type: "text", text: "University of Michigan" });
  expect(await greenhouse.readBack(page, s2)).toBe("University of Michigan - Dearborn");
});

test("greenhouse fill refuses an ambiguous prefix match", async () => {
  await page.setContent(fakeSelect(["University of Michigan - Dearborn", "University of Michigan - Flint"]));
  const school = (await greenhouse.readFields(page)).find(f => f.label === "School")!;
  await expect(greenhouse.fill(page, school, { type: "text", text: "University of Michigan" })).rejects.toThrow(/Ambiguous/);
  expect(await greenhouse.readBack(page, school)).toBeNull();
});

test("greenhouse readOptions lists a react-select's whole list with its typed text cleared, and leaves it empty", async () => {
  await page.setContent(fakeSelect(["Associate's Degree", "Bachelor's Degree", "Master's Degree"]));
  const degree = (await greenhouse.readFields(page)).find(f => f.label === "School")!;
  await expect(greenhouse.fill(page, degree, { type: "text", text: "B.S." })).rejects.toThrow(/No option matching/);
  await page.locator("#s").fill("B.S.");
  expect(await greenhouse.readOptions!(page, degree, "B.S.")).toEqual(["Associate's Degree", "Bachelor's Degree", "Master's Degree"]);
  expect(await page.locator("#s").inputValue()).toBe("");
  await greenhouse.fill(page, degree, { type: "option", option: "Bachelor's Degree" });
  expect(await greenhouse.readBack(page, degree)).toBe("Bachelor's Degree");
  expect(await page.locator("body").getAttribute("data-decoy")).toBeNull();
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
