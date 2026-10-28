import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ashby } from "../../src/ats/ashby.js";
import { detectAts } from "../../src/ats/registry.js";
import { inPage } from "../../src/forms/in-page.js";

const fixture = readFileSync(new URL("../fixtures/ashby/application.html", import.meta.url), "utf8");
const JOB = "https://jobs.ashbyhq.com/hiya/046212dd-41e3-46e7-a8ba-48cff5a7f947";
const RESUME = new URL("../fixtures/resume-sample.pdf", import.meta.url).pathname;

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

const serve = (url: string, html: string, status = 200) =>
  context.route(url, r => r.fulfill({ status, contentType: "text/html", body: html }));

/** Adds the behavior Ashby's React code has and the inert fixture lacks: Yes/No buttons toggle aria-pressed. */
const wireYesNo = () => page.evaluate(inPage(() => {
  document.querySelectorAll(".ashby-application-form-input-yesno-option").forEach(b => b.addEventListener("click", () => {
    const pressed = b.getAttribute("aria-pressed") === "true";
    b.parentElement!.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", pressed ? "false" : "true");
  }));
}));

test("ashby matches its host only, and the registry routes to it", () => {
  for (const u of [JOB, `${JOB}/application`, `${JOB}/application?embed=true`]) {
    expect(ashby.matches(u), u).toBe(true);
    expect(detectAts(u)?.name, u).toBe("ashby");
  }
  for (const u of ["https://evil.com/jobs.ashbyhq.com/x/y", "https://ashbyhq.com/x", "https://jobs.ashbyhq.com.evil.com/x/y", "not a url", ""]) {
    expect(ashby.matches(u), u).toBe(false);
  }
});

test("ashby open ends the path in /application (keeping the query) and waits for the form", async () => {
  const visited: string[] = [];
  await context.route(/jobs\.ashbyhq\.com/, r => {
    visited.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "text/html", body: fixture });
  });
  expect(await ashby.open(page, JOB)).toEqual({ ok: true });
  expect(visited[0]).toBe(`${JOB}/application`);
  visited.length = 0;
  expect(await ashby.open(page, `${JOB}/application?embed=true`)).toEqual({ ok: true });
  expect(visited[0]).toBe(`${JOB}/application?embed=true`);
  visited.length = 0;
  expect(await ashby.open(page, `${JOB}/`)).toEqual({ ok: true });
  expect(visited[0]).toBe(`${JOB}/application`);
});

test("ashby open waits for the SPA to render the form", async () => {
  await serve(`${JOB}/application`, `<div id="root"></div><script>setTimeout(function () {
    document.getElementById("root").innerHTML = '<div class="ashby-application-form-container"><input name="x"></div>';
  }, 1500);</script>`);
  expect(await ashby.open(page, JOB)).toEqual({ ok: true });
});

test("ashby open: 404 and 'not found' are closed; bot walls and foreign pages are blocked", async () => {
  await serve(`${JOB}/application`, "<h1>Not found</h1>", 404);
  expect(await ashby.open(page, JOB)).toMatchObject({ ok: false, reason: "closed" });
  await context.unroute(`${JOB}/application`);

  await serve(`${JOB}/application`, "<main><h2>The job you requested was not found.</h2></main>");
  expect(await ashby.open(page, JOB)).toMatchObject({ ok: false, reason: "closed" });
  await context.unroute(`${JOB}/application`);

  await serve(`${JOB}/application`, "<title>Just a moment...</title><p>Checking your browser</p>", 403);
  expect(await ashby.open(page, JOB)).toMatchObject({ ok: false, reason: "blocked" });
  await context.unroute(`${JOB}/application`);

  await serve(`${JOB}/application`, "<main><h1>Something else entirely</h1></main>");
  expect(await ashby.open(page, JOB)).toMatchObject({ ok: false, reason: "blocked" });
});

test("ashby open never clicks anything", async () => {
  await context.route(/jobs\.ashbyhq\.com/, r => r.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  await page.exposeFunction("aaClicked", () => { throw new Error("clicked"); });
  await page.addInitScript(() => document.addEventListener("click", () => (window as any).aaClicked(), true));
  expect(await ashby.open(page, JOB)).toEqual({ ok: true });
});

test("ashby fixture: core fields, Yes/No button pairs as radio, autofill widget excluded", async () => {
  await page.setContent(fixture);
  const fields = await ashby.readFields(page);
  const by = (label: string) => fields.find(f => f.label === label);
  expect(by("Full Legal Name")).toMatchObject({ kind: "text", required: true });
  expect(by("Preferred Name")).toMatchObject({ kind: "text", required: false });
  expect(by("Email")).toMatchObject({ kind: "email", required: true });
  expect(by("Phone Number")).toMatchObject({ kind: "tel", required: true });
  expect(by("Location")).toMatchObject({ kind: "combobox", required: true });
  expect(by("Address")).toMatchObject({ kind: "textarea", required: true });
  expect(by("Resume")).toMatchObject({ kind: "file", required: true });
  expect(by("LinkedIn")).toMatchObject({ kind: "text", required: false });
  expect(by("Graduation Year")).toMatchObject({ kind: "radio", options: ["2026", "2027", "2028", "2029"] });
  // Yes/No button pairs
  expect(by("Policy Acknowledgment and Agreement")).toMatchObject({ kind: "radio", required: true, options: ["Yes", "No"] });
  expect(by("This role is a hybrid role with 3 days in our London office. Are you willing to work from our office in person 3 days a week?"))
    .toMatchObject({ kind: "radio", required: true, options: ["Yes", "No"] });
  // texting consent keeps its own radios and a readable label
  expect(fields.find(f => f.label.startsWith("Check Yes or No to indicate"))).toMatchObject({ kind: "radio" });
  // only the real resume upload: the "Autofill from resume" input is never a field
  expect(fields.filter(f => f.kind === "file").map(f => f.label)).toEqual(["Resume"]);
  expect(fields.filter(f => /autofill|\*/i.test(f.label))).toEqual([]);
  expect(new Set(fields.map(f => f.id)).size).toBe(fields.length);
  // fields come back in page order (name before email before resume)
  const order = ["Full Legal Name", "Email", "Location", "Resume", "Policy Acknowledgment and Agreement"].map(l => fields.findIndex(f => f.label === l));
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("ashby fixture: Yes/No buttons round-trip through fill/readBack, idempotently", async () => {
  await page.setContent(fixture);
  await wireYesNo();
  const fields = await ashby.readFields(page);
  const policy = fields.find(f => f.label === "Policy Acknowledgment and Agreement")!;
  expect(await ashby.readBack(page, policy)).toBeNull();
  await ashby.fill(page, policy, { type: "option", option: "Yes" });
  expect(await ashby.readBack(page, policy)).toBe("Yes");
  await ashby.fill(page, policy, { type: "option", option: "Yes" }); // already pressed: must not unselect
  expect(await ashby.readBack(page, policy)).toBe("Yes");
  await ashby.fill(page, policy, { type: "option", option: "no" });
  expect(await ashby.readBack(page, policy)).toBe("No");
  await expect(ashby.fill(page, policy, { type: "option", option: "Maybe" })).rejects.toThrow(/No option/);
  // other pairs are untouched
  const truthful = fields.find(f => f.label.startsWith("Do you confirm"))!;
  expect(await ashby.readBack(page, truthful)).toBeNull();
});

test("ashby fixture: text, native radios (incl. native Yes/No), and upload round-trip", async () => {
  await page.setContent(fixture);
  const fields = await ashby.readFields(page);
  const by = (label: string) => fields.find(f => f.label === label)!;
  await ashby.fill(page, by("Full Legal Name"), { type: "text", text: "Test Person" });
  expect(await ashby.readBack(page, by("Full Legal Name"))).toBe("Test Person");
  await ashby.fill(page, by("Graduation Year"), { type: "option", option: "2027" });
  expect(await ashby.readBack(page, by("Graduation Year"))).toBe("2027");
  const native = by("Do you have the right to work and live in the UK without visa sponsorship?");
  await ashby.fill(page, native, { type: "option", option: "No" });
  expect(await ashby.readBack(page, native)).toBe("No");
  await ashby.fill(page, by("Resume"), { type: "file", path: RESUME });
  expect(await ashby.readBack(page, by("Resume"))).toBe("resume-sample.pdf");
});

test("ashby location typeahead: exact, unique prefix, ambiguous prefix, no match", async () => {
  await page.setContent(`<div id="form"><div class="ashby-application-form-container"><div class="ashby-application-form-field-entry">
    <label class="ashby-application-form-question-title _required_x" for="loc">Location</label>
    <div><input class="ashby-application-form-input-autocomplete" role="combobox" aria-haspopup="listbox" aria-expanded="false" placeholder="Start typing..."></div></div></div></div>
    <div id="host"></div>
    <script>(function () {
      var places = ["London, Greater London, England, United Kingdom", "London, Ontario, Canada", "Paris, France", "Paris, Texas, United States"];
      var input = document.querySelector("input"), host = document.getElementById("host");
      input.addEventListener("input", function () {
        var q = input.value.toLowerCase();
        host.innerHTML = "";
        if (!q) { input.removeAttribute("aria-controls"); return; }
        input.setAttribute("aria-controls", ":r0:");
        var lb = document.createElement("div"); lb.id = ":r0:"; lb.setAttribute("role", "listbox"); host.appendChild(lb);
        places.filter(function (p) { return p.toLowerCase().indexOf(q) >= 0; }).forEach(function (p) {
          var o = document.createElement("div"); o.setAttribute("role", "option"); o.textContent = p;
          o.onclick = function () { input.value = p; host.innerHTML = ""; input.removeAttribute("aria-controls"); };
          lb.appendChild(o);
        });
      });
    })();</script>`);
  const field = (await ashby.readFields(page)).find(f => f.kind === "combobox")!;
  expect(field).toMatchObject({ label: "Location", required: true });
  await ashby.fill(page, field, { type: "text", text: "paris, f" });
  expect(await ashby.readBack(page, field)).toBe("Paris, France");
  await ashby.fill(page, field, { type: "option", option: "London, Ontario, Canada" });
  expect(await ashby.readBack(page, field)).toBe("London, Ontario, Canada");
  await expect(ashby.fill(page, field, { type: "text", text: "London" })).rejects.toThrow(/Ambiguous option/);
  expect(await ashby.readBack(page, field)).toBeNull(); // typed text that was never picked is not an answer
  await expect(ashby.fill(page, field, { type: "text", text: "Atlantis" })).rejects.toThrow(/No option matching/);
});

test("ashby fields include the survey (EEO) container and skip the autofill upload", async () => {
  await page.setContent(`<div id="form">
    <div class="ashby-application-form-autofill-uploader"><input type="file"><button>Upload file</button></div>
    <div class="ashby-application-form-container"><div class="ashby-application-form-field-entry" data-field-path="a">
      <label class="ashby-application-form-question-title _required_x" for="a">Name</label><input id="a" type="text"></div></div>
    <div class="ashby-survey-form-container"><div class="ashby-application-form-container"><div data-field-path="_systemfield_eeoc_gender">
      <fieldset class="ashby-application-form-input-radio-group"><label class="ashby-application-form-question-title _required_x" for="g">Gender</label>
        <label><input type="radio" name="g" value="m">Male</label><label><input type="radio" name="g" value="f">Female</label></fieldset></div></div></div></div>`);
  const fields = await ashby.readFields(page);
  expect(fields.map(f => [f.label, f.kind, f.required])).toEqual([["Name", "text", true], ["Gender", "radio", true]]);
});

test("ashby outcome: a fresh form is pending", async () => {
  await page.setContent(fixture);
  expect(await ashby.outcome(page)).toEqual({ kind: "pending" });
});

test("ashby outcome ignores thank-you and captcha wording in the posting text", async () => {
  await page.setContent(fixture);
  const inject = (selector: string, html: string) => page.evaluate(inPage((a: { s: string; h: string }) => {
    document.querySelector(a.s)!.insertAdjacentHTML("afterbegin", a.h);
  }), { s: selector, h: html });
  await inject(".ashby-job-posting-left-pane", "<p>Thank you for applying! Your application was successfully submitted.</p>");
  await inject(".ashby-job-posting-right-pane", "<div class='ashby-job-posting-description-container'><p>Thank you for applying. Application submitted. Solve the captcha, enter your security code review.</p><input name='x'></div>");
  expect(await ashby.outcome(page)).toEqual({ kind: "pending" });
  // even with the form hidden, text outside a confirmation area is not a result
  await page.evaluate(inPage(() => { (document.querySelector(".ashby-application-form-container") as HTMLElement).style.display = "none"; }));
  expect(await ashby.outcome(page)).toEqual({ kind: "pending" });
});

test("ashby outcome: success container or thank-you text once the form is gone", async () => {
  await page.setContent(`<div class="ashby-job-posting-right-pane"><div class="ashby-application-form-success-container">
    <div role="status"><strong>Success</strong><p>Your application was successfully submitted. We'll contact you if there are next steps.</p></div></div></div>`);
  expect(await ashby.outcome(page)).toEqual({ kind: "submitted" });
  await page.setContent("<main><h2>Thank you for applying!</h2></main>");
  expect(await ashby.outcome(page)).toEqual({ kind: "submitted" });
  await page.setContent("<main><p>Your application was submitted.</p></main>");
  expect(await ashby.outcome(page)).toEqual({ kind: "submitted" });
  // a success container next to a still-visible form is not a result
  await page.setContent(`<div class="ashby-application-form-container"><input name="x"></div><div class="ashby-application-form-success-container"><p>Success</p></div>`);
  expect(await ashby.outcome(page)).toEqual({ kind: "pending" });
});

test("ashby outcome: 'Your form needs corrections' is a validation error with the field labels", async () => {
  await page.setContent(`<div class="ashby-application-form-container">
    <div role="alert" aria-live="assertive"><h3>Your form needs corrections</h3><ul>
      <li><p>Missing entry for required field: <a href="#">Email</a></p></li><li><p>Missing entry for required field: <a href="#">Resume</a></p></li></ul></div>
    <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Email</label><input aria-invalid="true"></div>
    <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Major</label><input aria-invalid="true"></div></div>`);
  expect(await ashby.outcome(page)).toEqual({
    kind: "validation-error",
    messages: ["Missing entry for required field: Email", "Missing entry for required field: Resume", "Major: invalid"],
  });
});

test("ashby outcome: a failure container is unknown with its text; recaptcha challenge is a captcha", async () => {
  await page.setContent(`<div class="ashby-application-form-container"><input name="x"></div>
    <div class="ashby-application-form-failure-container"><div role="alert"><h3>We couldn't submit your application</h3><p>Your application submission was flagged as possible spam.</p></div></div>`);
  expect(await ashby.outcome(page)).toEqual({ kind: "unknown", detail: "We couldn't submit your application Your application submission was flagged as possible spam." });

  await page.setContent(`<div class="ashby-application-form-container"><input name="x"></div>
    <iframe title="recaptcha challenge expires in two minutes" src="https://www.google.com/recaptcha/api2/bframe?hl=en" width="400" height="580"></iframe>`);
  expect(await ashby.outcome(page)).toEqual({ kind: "captcha" });
  // the invisible anchor is not a challenge
  await page.setContent(`<div class="ashby-application-form-container"><input name="x"></div>
    <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?ar=1" style="display:none"></iframe>`);
  expect(await ashby.outcome(page)).toEqual({ kind: "pending" });
});

test("ashby submit clicks the Submit Application button and nothing else", async () => {
  await page.setContent(fixture);
  await page.evaluate(inPage(() => {
    (window as any).clicks = [];
    document.addEventListener("click", e => { (window as any).clicks.push((e.target as Element).closest("button")?.textContent?.trim()); e.preventDefault(); }, true);
  }));
  await ashby.submit(page);
  expect(await page.evaluate(inPage(() => (window as any).clicks))).toEqual(["Submit Application"]);
});

test("ashby description: absent on the bare application page, read when the overview shows it", async () => {
  await page.setContent(fixture);
  expect(await ashby.description(page)).toBeUndefined();
  await page.setContent(`<div id="overview" class="ashby-job-posting-description-container"><div class="ashby-job-posting-description"><h2>About the Role</h2><p>Build things.</p></div></div>`);
  expect(await ashby.description(page)).toBe("About the Role\n\nBuild things.");
});
