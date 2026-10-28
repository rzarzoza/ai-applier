import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { lever } from "../../src/ats/lever.js";
import { detectAts } from "../../src/ats/registry.js";
import { inPage } from "../../src/forms/in-page.js";

const fixture = readFileSync(new URL("../fixtures/lever/apply.html", import.meta.url), "utf8");
const JOB = "https://jobs.lever.co/make-rain/b45f0d52-9c7e-4c1a-8f3e-2f6a1d7c9e10";

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

test("lever matches its hosts only, and the registry routes to it", () => {
  for (const u of [JOB, `${JOB}/apply`, "https://jobs.eu.lever.co/cirrus/533c/apply"]) {
    expect(lever.matches(u), u).toBe(true);
    expect(detectAts(u)?.name, u).toBe("lever");
  }
  for (const u of ["https://evil.com/jobs.lever.co/x/y", "https://lever.co/x", "https://jobs.lever.co.evil.com/x/y", "not a url", ""]) {
    expect(lever.matches(u), u).toBe(false);
  }
});

test("lever open appends /apply and succeeds once the form shows", async () => {
  const visited: string[] = [];
  await context.route(/jobs\.lever\.co/, r => {
    visited.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "text/html", body: fixture });
  });
  expect(await lever.open(page, JOB)).toEqual({ ok: true });
  expect(visited[0]).toBe(`${JOB}/apply`);
  visited.length = 0;
  expect(await lever.open(page, `${JOB}/apply`)).toEqual({ ok: true });
  expect(visited[0]).toBe(`${JOB}/apply`);
  visited.length = 0;
  expect(await lever.open(page, `${JOB}/?lever-source=Simplify`)).toEqual({ ok: true });
  expect(visited[0]).toBe(`${JOB}/apply?lever-source=Simplify`);
});

test("lever open: 404 and 'no longer accepting' are closed; bot walls and foreign pages are blocked", async () => {
  await serve(`${JOB}/apply`, "<h1>Not found</h1><p>The job posting you're looking for might have closed.</p>", 404);
  expect(await lever.open(page, JOB)).toMatchObject({ ok: false, reason: "closed" });
  await context.unroute(`${JOB}/apply`);

  await serve(`${JOB}/apply`, "<main><h2>This job is no longer accepting applications.</h2></main>");
  expect(await lever.open(page, JOB)).toMatchObject({ ok: false, reason: "closed" });
  await context.unroute(`${JOB}/apply`);

  await serve(`${JOB}/apply`, "<title>Just a moment...</title><p>Checking your browser</p>", 403);
  expect(await lever.open(page, JOB)).toMatchObject({ ok: false, reason: "blocked" });
  await context.unroute(`${JOB}/apply`);

  await serve(`${JOB}/apply`, "<main><h1>Something else entirely</h1></main>");
  expect(await lever.open(page, JOB)).toMatchObject({ ok: false, reason: "blocked" });
});

test("lever open never clicks anything", async () => {
  await context.route(/jobs\.lever\.co/, r => r.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  await page.exposeFunction("aaClicked", () => { throw new Error("clicked"); });
  await page.addInitScript(() => document.addEventListener("click", () => (window as any).aaClicked(), true));
  expect(await lever.open(page, JOB)).toEqual({ ok: true });
});

test("lever fixture: core fields extracted with clean labels", async () => {
  await page.setContent(fixture);
  const fields = await lever.readFields(page);
  const by = (label: string) => fields.find(f => f.label === label);
  expect(by("Full name")).toMatchObject({ kind: "text", required: true });
  expect(by("Email")).toMatchObject({ kind: "email", required: true });
  expect(by("Phone")).toMatchObject({ kind: "text", required: false });
  expect(by("Resume/CV")).toMatchObject({ kind: "file", required: true });
  expect(by("LinkedIn URL")).toMatchObject({ kind: "text", required: true });
  expect(by("GitHub URL")).toMatchObject({ kind: "text", required: false });
  expect(by("Gender")).toMatchObject({ kind: "select", options: ["Male", "Female", "Decline to self-identify"] });
  expect(by("What degree are you currently enrolled in?")).toMatchObject({ kind: "radio", required: true, options: ["PhD", "Master's", "Bachelor's", "Other"] });
  expect(by("In 1-3 sentences, tell us about one thing TRI is working on that you find exciting?")).toMatchObject({ kind: "textarea", required: true });
  // no label keeps the required star or the upload widget's helper text
  expect(fields.filter(f => /[✱*]|Analyzing|ATTACH/i.test(f.label)).map(f => f.label)).toEqual([]);
  expect(new Set(fields.map(f => f.id)).size).toBe(fields.length);
});

test("lever fixture: fill and read back text, radio, select and upload", async () => {
  await page.setContent(fixture);
  const fields = await lever.readFields(page);
  const by = (label: string) => fields.find(f => f.label === label)!;
  await lever.fill(page, by("Full name"), { type: "text", text: "Test Person" });
  expect(await lever.readBack(page, by("Full name"))).toBe("Test Person");
  const degree = by("What degree are you currently enrolled in?");
  await lever.fill(page, degree, { type: "option", option: "Master's" });
  expect(await lever.readBack(page, degree)).toBe("Master's");
  await lever.fill(page, by("Gender"), { type: "option", option: "Female" });
  expect(await lever.readBack(page, by("Gender"))).toBe("Female");
  await lever.fill(page, by("Resume/CV"), { type: "file", path: new URL("../fixtures/resume-sample.pdf", import.meta.url).pathname });
  expect(await lever.readBack(page, by("Resume/CV"))).toBe("resume-sample.pdf");
});

test("lever afterUpload waits while 'Analyzing resume...' shows, and returns soon when no parse starts", async () => {
  await page.setContent(fixture);
  // As Lever does: the working indicator shows, then the parse result is written and the indicator hides.
  await page.evaluate(inPage(() => {
    const working = document.querySelector(".resume-upload-working") as HTMLElement;
    working.style.display = "inline";
    setTimeout(() => {
      (document.querySelector('input[name="location"]') as HTMLInputElement).value = "";
      working.style.display = "none";
    }, 800);
  }), undefined);
  let t = Date.now();
  await lever.afterUpload!(page);
  expect(Date.now() - t).toBeGreaterThanOrEqual(800);
  expect(await page.locator(".resume-upload-working").isVisible()).toBe(false);

  await page.setContent(fixture);
  t = Date.now();
  await lever.afterUpload!(page);
  expect(Date.now() - t).toBeLessThan(6000);
});

test("lever outcome: a fresh form is pending", async () => {
  await page.setContent(fixture);
  expect(await lever.outcome(page)).toEqual({ kind: "pending" });
});

test("lever outcome ignores thank-you and captcha wording in the posting text", async () => {
  await page.setContent(fixture);
  const inject = (selector: string, text: string) => page.evaluate(inPage((a: { s: string; t: string }) => {
    const p = document.createElement("p");
    p.textContent = a.t;
    document.querySelector(a.s)!.prepend(p);
  }), { s: selector, t: text });
  await inject(".posting-header", "Thank you for applying! Your application has been submitted.");
  await inject(".main-footer-text", "Application received. Thanks for applying to hCaptcha challenge security code review.");
  expect(await lever.outcome(page)).toEqual({ kind: "pending" });
  // even with the form hidden, text outside a confirmation area is not a result
  await page.evaluate(inPage(() => { (document.getElementById("application-form") as HTMLElement).style.display = "none"; }));
  expect(await lever.outcome(page)).toEqual({ kind: "pending" });
});

test("lever outcome detects the thanks page by URL and by text", async () => {
  await serve("https://jobs.lever.co/acme/1/thanks", "<html><body><h1>Done</h1></body></html>");
  await page.goto("https://jobs.lever.co/acme/1/thanks");
  expect(await lever.outcome(page)).toEqual({ kind: "submitted" });
  await serve("https://jobs.lever.co/acme/1/thanks/", "<html><body><h1>Done</h1></body></html>");
  await page.goto("https://jobs.lever.co/acme/1/thanks/");
  expect(await lever.outcome(page)).toEqual({ kind: "submitted" });
  await serve("https://jobs.lever.co/thanksco/1/apply?ref=/thanks", `<form id="application-form"><input name="name"></form>`);
  await page.goto("https://jobs.lever.co/thanksco/1/apply?ref=/thanks");
  expect(await lever.outcome(page)).toEqual({ kind: "pending" });

  await page.setContent("<main><h2>Application submitted!</h2><p>Thanks for applying.</p></main>");
  expect(await lever.outcome(page)).toEqual({ kind: "submitted" });
});

test("lever outcome detects validation errors and a hCaptcha challenge", async () => {
  await page.setContent(`<form id="application-form">
    <ul><li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><input name="name" aria-invalid="true"></label>
      <span class="error-message">This field is required.</span></li>
      <li class="application-question"><label><div class="application-label">Email</div><input name="email"></label><span class="error-message" style="display:none">Hidden</span></li></ul>
    <button id="btn-submit" type="button">Submit application</button></form>`);
  expect(await lever.outcome(page)).toEqual({ kind: "validation-error", messages: ["This field is required."] });

  await page.setContent(`<form id="application-form"><input name="name"></form>
    <iframe title="Main content of the hCaptcha challenge" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html" width="400" height="580"></iframe>`);
  expect(await lever.outcome(page)).toEqual({ kind: "captcha" });
  // the invisible hCaptcha anchor is not a challenge
  await page.setContent(`<form id="application-form"><input name="name"></form>
    <iframe title="Widget containing checkbox for hCaptcha security challenge" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox" style="display:none"></iframe>`);
  expect(await lever.outcome(page)).toEqual({ kind: "pending" });
});

test("lever outcome: captcha wording in the posting is not a captcha", async () => {
  await page.setContent(fixture);
  await page.evaluate(inPage(() => {
    document.querySelector(".posting-header")!.insertAdjacentHTML("afterbegin", "<p>Solve the captcha challenge. Enter your verification code.</p><input name=\"x\">");
  }));
  expect(await lever.outcome(page)).toEqual({ kind: "pending" });
});

test("lever submit clicks #btn-submit and nothing else", async () => {
  await page.setContent(fixture);
  await page.evaluate(inPage(() => {
    (window as any).clicks = [];
    document.addEventListener("click", e => { (window as any).clicks.push((e.target as Element).id); e.preventDefault(); }, true);
  }));
  await lever.submit(page);
  expect(await page.evaluate(inPage(() => (window as any).clicks))).toEqual(["btn-submit"]);
});

test("lever description is absent on the bare apply page", async () => {
  await page.setContent(fixture);
  expect(await lever.description(page)).toBeUndefined();
});

test("lever select2 picker: exact, unique prefix, ambiguous prefix, and read back from the hidden select", async () => {
  await page.setContent(`<form id="application-form"><ul><li class="application-question custom-question">
    <div class="application-label"><div class="text">Which university do you attend?<span class="required">✱</span></div></div>
    <div class="application-field"><select name="cards[x][field0]" required class="select2-hidden-accessible" aria-hidden="true" tabindex="-1">
      <option value="">Select</option><option>Curtin University</option><option>University of Adelaide</option><option>University of Canberra</option></select>
    <span class="select2-selection" role="combobox" tabindex="0" aria-owns="res" style="display:block;min-height:20px">Select a university</span></div></li></ul></form>
    <div id="dropdown" hidden><input class="select2-search__field" type="search"><ul id="res"></ul></div>
    <script>(function () {
      var names = ["Curtin University", "University of Adelaide", "University of Canberra"];
      var sel = document.querySelector("select"), res = document.getElementById("res"), search = document.querySelector(".select2-search__field");
      function render() {
        res.innerHTML = "";
        names.filter(function (n) { return n.toLowerCase().indexOf(search.value.toLowerCase()) >= 0; }).forEach(function (n) {
          var li = document.createElement("li"); li.className = "select2-results__option"; li.setAttribute("role", "treeitem"); li.textContent = n;
          li.onclick = function () { sel.value = n; document.getElementById("dropdown").hidden = true; }; res.appendChild(li);
        });
      }
      document.querySelector("[role=combobox]").onclick = function () { document.getElementById("dropdown").hidden = false; render(); };
      search.oninput = render;
    })();</script>`);
  const field = (await lever.readFields(page)).find(f => f.kind === "combobox")!;
  expect(field).toMatchObject({ label: "Which university do you attend?", required: true });
  expect(field.options).toBeUndefined();
  await lever.fill(page, field, { type: "text", text: "curtin" });
  expect(await lever.readBack(page, field)).toBe("Curtin University");
  await expect(lever.fill(page, field, { type: "text", text: "University of" })).rejects.toThrow(/Ambiguous option/);
  expect(await lever.readBack(page, field)).toBe("Curtin University");
  await lever.fill(page, field, { type: "option", option: "University of Adelaide" });
  expect(await lever.readBack(page, field)).toBe("University of Adelaide");
});
