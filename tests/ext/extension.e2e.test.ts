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
import { getOverrides, listQuestions } from "../../src/answers/bank.js";
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
const llm = () => {
  const base = fakeLlm();
  return base.on("classify", (req: { content: unknown }) => ({
    fields: (JSON.parse(String(req.content)) as { fields: { id: string; label: string }[] }).fields.map(f => ({
      id: f.id, profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: false, isCompanySpecific: false, category: "question",
      ...MINI_CLASSES[f.label], ...SHADOW_CLASSES[f.label],
    })),
  }));
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
    res.end(req.url?.startsWith("/mini/jobs/") ? fixture : req.url?.startsWith("/oneclick-ui/") ? shadowFixture : "<html><body>Not an application</body></html>");
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
    country: "United States", linkedin: "https://linkedin.com/in/luis", resumePath: resume,
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
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--host-resolver-rules=MAP job-boards.greenhouse.io 127.0.0.1, MAP jobs.smartrecruiters.com 127.0.0.1, MAP example.test 127.0.0.1"],
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
