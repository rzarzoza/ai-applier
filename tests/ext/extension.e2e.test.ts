/**
 * The unpacked extension in Chromium against the real app (startApp, FakeLlm) and a fixture "Greenhouse" page served
 * locally (the browser maps job-boards.greenhouse.io to 127.0.0.1). The test, never the extension, clicks submit.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getOverrides, listQuestions, setOverride } from "../../src/answers/bank.js";
import { openDb } from "../../src/db/db.js";
import { getExtToken } from "../../src/ext/api.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import { startApp } from "../../src/main.js";
import { saveProfile } from "../../src/profile/profile.js";
import { saveSettings } from "../../src/settings.js";
import { fakeLlm, until } from "../helpers/live-setup.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const fixture = readFileSync(new URL("../fixtures/forms/mini-ats.html", import.meta.url), "utf8");
const shadowFixture = readFileSync(new URL("../fixtures/forms/shadow-ats.html", import.meta.url), "utf8");
const form = (name: string) => readFileSync(new URL(`../fixtures/forms/${name}`, import.meta.url), "utf8");
/** Pages by path prefix: Greenhouse react-select pickers, Ashby (Yes/No + resume parser), a Workday-like multi-step flow. */
const PAGES: [string, string][] = [["/rs/jobs/", form("react-select.html")], ["/mini/", form("ashby-like.html")], ["/en-US/External/", form("workday-like.html")]];

/** The mini ATS's classifications (helpers/live-setup.ts) plus the SmartRecruiters-like fixture's. */
const SHADOW_CLASSES: Record<string, Record<string, unknown>> = {
  "First name": { category: "profile", profileKey: "firstName", isFactual: true },
  "Last name": { category: "profile", profileKey: "lastName", isFactual: true },
  "Confirm your email": { category: "profile", profileKey: "email", isFactual: true },
  City: { category: "profile", profileKey: "location", isFactual: true },
  "Country code": { category: "profile", profileKey: "country", isFactual: true },
  LinkedIn: { category: "profile", profileKey: "linkedin", isFactual: true },
  "How did you hear about us?": { category: "question", canonicalQuestion: "How did you hear about this job?", isFactual: true },
  Resume: { category: "resume", isFactual: false },
};
/** The custom-widget fixtures' fields (Greenhouse react-select, Ashby, Workday). */
const WIDGET_CLASSES: Record<string, Record<string, unknown>> = {
  Country: { category: "profile", profileKey: "country", isFactual: true },
  "Location (City)": { category: "profile", profileKey: "city", isFactual: true },
  "Will you now or in the future require sponsorship?": { category: "profile", profileKey: "requiresSponsorship", isFactual: true },
  "Will you now or in the future require visa sponsorship?": { category: "profile", profileKey: "requiresSponsorship", isFactual: true },
  "Are you legally authorized to work in the United States?": { category: "profile", profileKey: "workAuthorizedUS", isFactual: true },
  School: { category: "profile", profileKey: "school", isFactual: true },
  Degree: { category: "profile", profileKey: "degree", isFactual: true },
  Discipline: { category: "profile", profileKey: "major", isFactual: true },
  Gender: { category: "profile", profileKey: "gender", isFactual: true },
  Name: { category: "profile", profileKey: "fullName", isFactual: true },
  Location: { category: "profile", profileKey: "location", isFactual: true },
  "Have you previously worked for Mini?": { category: "derived", derivedKey: "workedAtCompany", isFactual: true },
  "How Did You Hear About Us?": { category: "question", canonicalQuestion: "How did you hear about this job?", isFactual: true },
  "Phone Number": { category: "profile", profileKey: "phone", isFactual: true },
};
const llm = () => {
  const base = fakeLlm();
  return base.on("classify", (req: { content: unknown }) => ({
    fields: (JSON.parse(String(req.content)) as { fields: { id: string; label: string }[] }).fields.map(f => ({
      id: f.id, profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: false, isCompanySpecific: false, category: "question",
      ...MINI_CLASSES[f.label], ...SHADOW_CLASSES[f.label], ...WIDGET_CLASSES[f.label],
    })),
  }))
    // No LLM mapping in these tests: a value the extension can't match stays unmatched.
    .on("adapt", () => ({ option: null, options: null }))
    .on("variants", () => ({ variants: [] }));
};
const MINI_CLASSES: Record<string, Record<string, unknown>> = {
  "First Name": { category: "profile", profileKey: "firstName", isFactual: true },
  Email: { category: "profile", profileKey: "email", isFactual: true },
  Phone: { category: "profile", profileKey: "phone", isFactual: true },
  "Are you willing to relocate?": { category: "profile", profileKey: "willingToRelocate", isFactual: true },
  "Tell us about a project you are proud of": { category: "question", canonicalQuestion: "Describe a project you are proud of.", isFactual: false },
  "I certify that the information above is accurate": { category: "consent-required" },
  "Text me about new roles": { category: "optin-optional" },
};
const secrets = { get: async () => null, set: async () => {} };

let site: http.Server;
let sitePort = 0;
const posted: Record<string, string>[] = [];
let app: Awaited<ReturnType<typeof startApp>>;
let dataDir: string;
let ctx: BrowserContext;
let jobId: string;

beforeAll(async () => {
  const extDir = mkdtempSync(path.join(tmpdir(), "ai-applier-ext-"));
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build-ext.mjs"), extDir], { cwd: ROOT });

  site = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => { posted.push(JSON.parse(body) as Record<string, string>); res.end("ok"); });
      return;
    }
    res.setHeader("content-type", "text/html");
    const page = PAGES.find(([prefix]) => req.url?.startsWith(prefix) && !req.url.startsWith("/mini/jobs/"))?.[1];
    res.end(req.url?.startsWith("/mini/jobs/") ? fixture : req.url?.startsWith("/oneclick-ui/") ? shadowFixture : page ?? "<html><body>Not an application</body></html>");
  });
  await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
  sitePort = (site.address() as AddressInfo).port;

  // The app's data: a profile with no phone (so the user types it), and the job the page is.
  dataDir = mkdtempSync(path.join(tmpdir(), "ai-applier-ext-app-"));
  const seed = openDb(path.join(dataDir, "app.db"));
  saveSettings(seed, { paused: true });
  const resume = path.join(dataDir, "resume.pdf");
  writeFileSync(resume, "%PDF-1.4 test resume");
  saveProfile(seed, {
    firstName: "Luis", lastName: "Hernandez", email: "luis@example.com", phone: null, willingToRelocate: true, city: "Houston", state: "Texas",
    country: "USA", linkedin: "https://linkedin.com/in/luis", resumePath: resume,
    school: "Rice University", degree: "B.S.", major: "Computer Sci & Eng", graduationMonth: "2999-05", gender: "Male",
    workAuthorizedUS: true, requiresSponsorship: false, employers: ["Onshape"],
  });
  const { job } = upsertPosting(seed, {
    sourceId: "test", listingId: "42", company: "Mini Co", title: "Software Engineer Intern", locations: ["Austin, TX"], category: null,
    terms: ["Summer 2027"], degrees: [], sponsorship: null, url: "https://job-boards.greenhouse.io/mini/jobs/42", datePosted: new Date(), active: true,
  });
  setStatus(seed, job.id, "needs-you", "1 question needs you");
  jobId = job.id;
  const token = getExtToken(seed);
  seed.close();
  app = await startApp({ dataDir, port: 0, startLoops: false, secrets, llm: llm(), handlers: [] });

  ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "ai-applier-ext-profile-")), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--host-resolver-rules=MAP job-boards.greenhouse.io 127.0.0.1, MAP jobs.smartrecruiters.com 127.0.0.1, MAP example.test 127.0.0.1, MAP jobs.ashbyhq.com 127.0.0.1, MAP mini.wd1.myworkdayjobs.com 127.0.0.1"],
  });
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  await sw.evaluate(cfg => chrome.storage.local.set(cfg), { token, apiBase: app.url });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
  await app?.stop();
  site?.close();
});

const panelText = (page: Page) => page.locator("#ai-applier-panel-host").evaluate(e => e.shadowRoot?.textContent ?? "").catch(() => "");

test("on an application page it fills the form by itself, lists what's left, and records the user's submission", async () => {
  const page = await ctx.newPage();
  await page.goto(`http://job-boards.greenhouse.io:${sitePort}/mini/jobs/42?gh_src=simplify`);

  // Auto-activated: filled from the profile and consent rules; the phone (unknown) is left for the user.
  await until(async () => (await page.inputValue("#first")) === "Luis", 15_000);
  await until(async () => (await panelText(page)).includes("need"), 10_000);
  expect(await page.inputValue("#email")).toBe("luis@example.com");
  expect(await page.inputValue("#reloc")).toBe("y");
  expect(await page.isChecked("input[name=certify]")).toBe(true);
  expect(await page.isChecked("input[name=sms]")).toBe(false);
  expect(await page.inputValue("#phone")).toBe("");
  const text = await panelText(page);
  expect(text).toContain("Filled 4 of 5 · 1 needs you");
  expect(text).toContain("Phone");
  expect(await page.locator("#first").evaluate(e => (e as HTMLElement).style.outline)).toContain("solid");

  // A refused submit (bad phone) is not recorded.
  await page.fill("#phone", "not a phone");
  await page.click("#submit");
  await page.waitForTimeout(5_000);
  expect(posted).toHaveLength(0);
  expect(getJobStatus()).toBe("needs-you");

  // The user types the phone and a project, then submits (the test clicks it, not the extension).
  await page.fill("#phone", "5559876543");
  await page.fill("#project", "A compiler for a toy language.");
  await page.click("#submit");
  await until(() => posted.length === 1, 10_000);
  expect(posted[0]).toMatchObject({ first: "Luis", email: "luis@example.com", phone: "5559876543", reloc: "y", certify: "on" });

  await until(() => getJobStatus() === "submitted", 15_000);
  await until(async () => (await panelText(page)).includes("Application sent"), 5_000);

  const db = openDb(path.join(dataDir, "app.db"));
  try {
    const phone = listQuestions(db).find(q => q.variants.includes("Phone"));
    expect(phone).toMatchObject({ status: "approved", answer: "5559876543" });
    const project = listQuestions(db).find(q => q.variants.includes("Tell us about a project you are proud of"));
    expect(project).toMatchObject({ status: "approved", answer: "A compiler for a toy language." });
    expect(getOverrides(db, jobId)).toMatchObject({ Phone: { type: "text", text: "5559876543" } });
  } finally { db.close(); }
  await page.close();
}, 90_000);

test("on a SmartRecruiters-style page (no <form>, fields in shadow roots, rendered late) it fills and records the submission", async () => {
  posted.length = 0;
  const page = await ctx.newPage();
  // Opened from the posting the app knows (as "I'm interested" does), so the submission lands on that job's row.
  const posting = `http://jobs.smartrecruiters.com:${sitePort}/Acme/744000000000001`;
  const url = `http://jobs.smartrecruiters.com:${sitePort}/oneclick-ui/company/Acme/publication/0b1c-22`;
  const seed = openDb(path.join(dataDir, "app.db"));
  const job = upsertPosting(seed, {
    sourceId: "test", listingId: "sr-1", company: "Acme", title: "Software Engineer Intern", locations: ["Houston, TX"], category: null,
    terms: ["Summer 2027"], degrees: [], sponsorship: null, url: posting, datePosted: new Date(), active: true,
  }).job;
  setStatus(seed, job.id, "queued");
  seed.close();
  await page.goto(url, { referer: posting });
  const host = (name: string) => page.evaluate(n => (window as unknown as { __hostValues: Record<string, string> }).__hostValues[n], name);
  await until(async () => (await host("first")) === "Luis", 15_000);
  await until(async () => (await panelText(page)).includes("need"), 15_000);
  expect(await host("last")).toBe("Hernandez");
  expect(await host("email")).toBe("luis@example.com");
  expect(await host("email2")).toBe("luis@example.com");
  expect(await host("city")).toBe("Houston, Texas, United States");
  expect(await host("code")).toBe("us");
  expect(await host("resume")).toBe("Luis_Hernandez_Resume.pdf"); // the stored resume.pdf, named for the employer
  const text = await panelText(page);
  expect(text).toContain("How did you hear about us?");

  // The user answers what was left (inside the component's shadow root), and the test clicks the shadow-DOM button.
  await page.locator('spl-input[name="hear"] input').fill("A friend at Acme");
  await page.locator("spl-button#submit button").click();
  await until(() => posted.length === 1, 10_000);
  expect(posted[0]).toMatchObject({ first: "Luis", city: "Houston, Texas, United States", hear: "A friend at Acme" });
  await until(async () => (await panelText(page)).includes("Application sent"), 10_000);

  const db = openDb(path.join(dataDir, "app.db"));
  try {
    expect(getJob(db, job.id)).toMatchObject({ company: "Acme", status: "submitted" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source_id = 'extension'").get()).toEqual({ n: 0 });
    const hear = listQuestions(db).find(q => q.variants.includes("How did you hear about us?"));
    expect(hear).toMatchObject({ status: "approved", answer: "A friend at Acme" });
  } finally { db.close(); }
  await page.close();
}, 90_000);

test("a page that isn't a known application site is left alone until asked", async () => {
  const page = await ctx.newPage();
  await page.goto(`http://example.test:${sitePort}/mini/jobs/7`);
  await page.waitForTimeout(2_500);
  expect(await page.locator("#ai-applier-panel-host").count()).toBe(0);
  expect(await page.inputValue("#first")).toBe("");
  await page.close();
}, 30_000);

function getJobStatus(): string | undefined {
  const db = openDb(path.join(dataDir, "app.db"));
  try { return getJob(db, jobId)?.status; } finally { db.close(); }
}

/** The panel's rows: each left item's label and note, and its quick-pick options. */
const panelItems = (page: Page) => page.locator("#ai-applier-panel-host").evaluate(e => Array.from(e.shadowRoot!.querySelectorAll(".item")).map(i => ({
  label: i.querySelector(".label")?.textContent ?? "", note: i.querySelector(".note")?.textContent ?? "",
  choices: Array.from(i.querySelectorAll(".chip")).map(c => c.textContent ?? ""),
}))).catch(() => []);
const values = (page: Page) => page.evaluate(() => (window as unknown as { __values: Record<string, unknown> }).__values);

test("Greenhouse react-select pickers: USA in the phone-country picker, Houston in Texas, education searches; a failed pick offers options", async () => {
  const page = await ctx.newPage();
  await page.goto(`http://job-boards.greenhouse.io:${sitePort}/rs/jobs/77`);
  await until(async () => /Filled \d+ of \d+/.test(await panelText(page)), 60_000);
  expect(await values(page)).toEqual({
    country: "United States +1", "candidate-location": "Houston, Texas, United States", question_1: "No",
    "school--0": "Rice University", "degree--0": "Bachelor's Degree", gender: "Male",
  });
  expect(await page.inputValue("#first_name")).toBe("Luis");
  // "Computer Sci & Eng" is not a listed discipline: the panel says why, with the closest options to pick.
  const items = await panelItems(page);
  const discipline = items.find(i => i.label.startsWith("Discipline"));
  expect(discipline?.note).toMatch(/^Couldn't fill it: No option for "Computer Sci & Eng" — options: Computer Engineering, Computer Science/);
  expect(discipline?.choices).toEqual(["Computer Engineering", "Computer Science"]);
  // (The phone comes from the bank: the first test taught it.)
  expect(await panelText(page)).toMatch(/Filled 9 of 10 · 1 needs you/);

  // One click picks it, and the app keeps it for this question.
  await page.locator("#ai-applier-panel-host").evaluate(e => {
    const chip = Array.from(e.shadowRoot!.querySelectorAll<HTMLButtonElement>(".chip")).find(c => c.textContent === "Computer Science")!;
    chip.click();
  });
  await until(async () => (await values(page))["discipline--0"] === "Computer Science", 15_000);
  await until(async () => (await panelText(page)).includes("Filled 10 of 10 · all set"), 10_000);
  const db = openDb(path.join(dataDir, "app.db"));
  try {
    const picks = db.prepare("SELECT value FROM kv WHERE key = 'extPicks'").get() as { value: string } | undefined;
    expect(JSON.parse(picks?.value ?? "{}")).toEqual({ discipline: { "computer sci & eng": "Computer Science" } });
  } finally { db.close(); }

  // The next form with the same question takes the picked option by itself.
  const again = await ctx.newPage();
  await again.goto(`http://job-boards.greenhouse.io:${sitePort}/rs/jobs/78`);
  await until(async () => (await values(again))["discipline--0"] === "Computer Science", 60_000);
  await page.close();
  await again.close();
}, 150_000);

test("Ashby: the resume goes first and the extension waits for Ashby's parser before filling; Yes/No pairs are pressed once", async () => {
  // jobs.ashbyhq.com is HSTS-preloaded (https only): the page is served by the browser context itself.
  await ctx.route("https://jobs.ashbyhq.com/**", route => route.fulfill({ contentType: "text/html", body: form("ashby-like.html") }));
  const page = await ctx.newPage();
  await page.goto("https://jobs.ashbyhq.com/mini/0f0e-11aa/application");
  await until(async () => /Filled \d+ of \d+/.test(await panelText(page)), 60_000);
  // The parser overwrote the name and cleared the location before anything else was filled: the values stand.
  expect(await page.evaluate(() => (window as unknown as { __parsedAt?: number }).__parsedAt)).toBeGreaterThan(0);
  expect(await page.inputValue("#_systemfield_name")).toBe("Luis Hernandez");
  expect(await page.inputValue("#_systemfield_email")).toBe("luis@example.com");
  expect(await values(page)).toMatchObject({ resume: "Luis_Hernandez_Resume.pdf", location: "Houston, Texas, United States", q_auth: "Yes", q_sponsor: "No" });
  expect(await page.inputValue("#loc")).toBe("Houston, Texas, United States");
  // "No" was already pressed: only "Yes" (authorized) was pressed, once; the autofill widget was never used.
  expect(await page.evaluate(() => (window as unknown as { __presses: number }).__presses)).toBe(1);
  expect(await values(page)).not.toHaveProperty("autofillUsed");
  expect(await panelText(page)).toContain("Filled 6 of 6 · all set");
  await page.close();
}, 90_000);

test("Workday: fills each step as it appears; the user clicks Save and Continue; Add sections are left to the user", async () => {
  const url = `http://mini.wd1.myworkdayjobs.com:${sitePort}/en-US/External/job/Houston-TX/Software-Engineer-Intern_R123/apply/applyManually`;
  const seed = openDb(path.join(dataDir, "app.db"));
  const job = upsertPosting(seed, {
    sourceId: "test", listingId: "wd-1", company: "Mini", title: "Software Engineer Intern", locations: ["Houston, TX"], category: null,
    terms: ["Summer 2027"], degrees: [], sponsorship: null, url: url.replace(/\/apply\/applyManually$/, ""), datePosted: new Date(), active: true,
  }).job;
  setOverride(seed, job.id, "How Did You Hear About Us?", { type: "text", text: "LinkedIn" });
  seed.close();
  const page = await ctx.newPage();
  await page.goto(url);
  await until(async () => (await panelText(page)).includes("Filled 4 of 4"), 60_000).catch(async e => {
    throw new Error(`${e}: ${(await panelText(page)).slice(-600)} ${JSON.stringify(await values(page))}`);
  });
  expect(await values(page)).toEqual({ legalNameSection_firstName: "Luis", countryDropdown: "United States of America", source: ["LinkedIn"], previousWorker: "false" });
  expect(await page.textContent("#input-2")).toBe("United States of America");

  // The user (here: the test) moves on; the extension fills the new step by itself and never clicks Next or Add.
  await page.click("#next");
  await until(async () => (await values(page)).sponsorship === "No", 60_000).catch(async e => {
    throw new Error(`${e}: ${(await panelText(page)).slice(-600)} ${JSON.stringify(await values(page))} ${await page.evaluate(() => document.getElementById("step")!.outerHTML)}`);
  });
  expect(await values(page)).toMatchObject({ workAuth: "Yes", sponsorship: "No" });
  await until(async () => (await panelText(page)).includes("Filled 2 of 2 · 1 needs you"), 15_000);
  expect((await panelItems(page)).map(i => i.label)).toEqual(["Work Experience"]);
  expect(await page.evaluate(() => (window as unknown as { __nextClicks: number }).__nextClicks)).toBe(1);
  expect(await values(page)).not.toHaveProperty("addClicked");
  await page.close();
}, 120_000);
