import { expect, test, vi } from "vitest";
import { addNeedsYou } from "../../src/answers/bank.js";
import { openDb } from "../../src/db/db.js";
import { HAND_UNCONFIRMED, setAts, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { JobStatus } from "../../src/jobs/types.js";
import { setRunnerCurrent } from "../../src/runner/current.js";
import { saveSettings } from "../../src/settings.js";
import type { Posting } from "../../src/sources/types.js";
import { createApp } from "../../src/web/server.js";
import { avatarColor, initials } from "../../src/web/ui.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const p = (n: number, extra: Partial<Posting> = {}): Posting => ({ sourceId: "s", listingId: String(n), company: `Co${n}`, title: `Intern ${n}`,
  locations: ["NYC"], category: null, terms: [], degrees: [], sponsorship: null, url: `https://x.test/${n}`,
  datePosted: new Date(Date.UTC(2026, 9, 1 + (n % 27))), active: true, ...extra });

function setup(requested: string[] = []) {
  const db = openDb(":memory:");
  saveSettings(db, { paused: false });
  const runHandFinish = vi.fn();
  const app = createApp({ db, llm: new FakeLlm(), runInteractive: vi.fn(), runReviewed: vi.fn(), runHandFinish, pollNow: vi.fn(), requestedRuns: () => requested });
  const mk = (n: number, status: JobStatus, reason: string | null = null, extra: Partial<Posting> = {}) => {
    const j = upsertPosting(db, p(n, extra)).job;
    setStatus(db, j.id, status, reason);
    return j;
  };
  return { db, app, runHandFinish, mk };
}
const get = async (app: ReturnType<typeof setup>["app"], path: string) => {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return res.text();
};
/** The HTML of one home list card, by its title. */
const section = (html: string, title: string) => {
  const start = html.indexOf(`<h2>${title} `);
  expect(start, title).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
};

test("GET / is the dashboard: nav with every tab, Home active, and light and dark tokens", async () => {
  const { app } = setup();
  const html = await get(app, "/");
  expect(html).toContain('<header class="topnav">');
  expect(html).toContain('<span class="brand-mark">AI</span><span class="brand-name">AI Applier</span>');
  for (const tab of ["Home", "Inbox", "Applications", "Answer bank", "Profile", "Sources &amp; filters", "Settings"])
    expect(html).toContain(`<span class="tab-label">${tab}</span>`);
  expect(html).toMatch(/<a href="\/" class="tab active" aria-current="page"/);
  expect(html).toContain("--bg: #f3f2ef");
  expect(html).toContain("--primary: #0a66c2");
  expect(html).toContain("@media (prefers-color-scheme: dark)");
  expect(html).toContain("--primary: #70b5f9");
  expect(html).toContain("--card: #1b1f23");
  expect(html).toContain("<h1>Home</h1>");
});

test("the Applying now card shows the runner's current job, step and elapsed time", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "filling");
  setAts(db, j.id, "greenhouse");
  setRunnerCurrent(db, { jobId: j.id, step: "Filling fields", startedAt: new Date(Date.now() - 125_000).toISOString(), mode: "auto" });
  for (const html of [await get(app, "/"), await get(app, "/home/now")]) {
    expect(html).toContain("Applying now");
    expect(html).toContain(`<a class="now-title" href="/applications/${j.id}">Intern 1</a>`);
    expect(html).toContain("Co1");
    expect(html).toContain("NYC");
    expect(html).toContain('<span class="chip chip-ats">greenhouse</span>');
    expect(html).toContain("Filling fields");
    expect(html).toMatch(/Started 2m 0[5-9]s ago/);
  }
  const frag = await get(app, "/home/now");
  expect(frag).not.toContain("<html");
  expect(frag).toContain('hx-get="/home/now" hx-trigger="every 3s" hx-swap="outerHTML"');
});

test("with nothing running the card is idle, or paused", async () => {
  const { db, app, mk } = setup();
  expect(await get(app, "/home/now")).toContain("Idle — nothing is queued right now.");
  mk(1, "queued");
  expect(await get(app, "/home/now")).toContain("Idle — next job starts shortly.");
  // A stale pointer to a job that no longer exists is ignored.
  setRunnerCurrent(db, { jobId: "gone", step: "Submitting", startedAt: new Date().toISOString() });
  expect(await get(app, "/home/now")).toContain("Idle — next job starts shortly.");
  saveSettings(db, { paused: true });
  const paused = await get(app, "/home/now");
  expect(paused).toContain("<strong>Paused</strong>");
  expect(paused).not.toContain("Idle");
});

test("stat tiles count each status and link to the filtered list", async () => {
  const { app, mk } = setup();
  let n = 0;
  for (const [status, count] of [["queued", 3], ["needs-you", 2], ["ready-to-review", 1], ["submitted", 4], ["unsupported", 5], ["failed", 1]] as const)
    for (let i = 0; i < count; i++) mk(++n, status);
  const html = await get(app, "/home/lists");
  for (const [status, count, label] of [["queued", 3, "Queued"], ["needs-you", 2, "Needs your input"], ["ready-to-review", 1, "Ready to review"],
    ["submitted", 4, "Submitted"], ["unsupported", 5, "Unsupported"]] as const) {
    expect(html).toMatch(new RegExp(`href="/applications\\?status=${status}"><span class="tile-n">${count}</span><span class="tile-label">${label}</span>`));
  }
});

test("each list shows its jobs with the right action", async () => {
  const { db, app, mk } = setup();
  const finish = mk(1, "needs-you", "1 question needs you");
  const captcha = mk(2, "needs-you", "CAPTCHA");
  addNeedsYou(db, { jobId: captcha.id, kind: "captcha", message: "solve" });
  const unknown = mk(3, "needs-you", HAND_UNCONFIRMED);
  const review = mk(4, "ready-to-review", "Waiting for your review");
  const queued = Array.from({ length: 17 }, (_, i) => mk(10 + i, "queued"));
  const submitted = Array.from({ length: 12 }, (_, i) => mk(40 + i, "submitted"));
  mk(60, "failed", "Boom");

  const html = await get(app, "/");
  const needs = section(html, "Needs your input");
  expect(needs).toContain(`<button class="primary" hx-post="/applications/${finish.id}/hand-finish" hx-target="this" hx-swap="outerHTML">Open &amp; finish</button>`);
  expect(needs).toContain("1 question needs you");
  expect(needs).toContain(`hx-post="/needs-you/${captcha.id}/do-it-now"`);
  expect(needs).not.toContain(`/applications/${captcha.id}/hand-finish`);
  expect(needs).toContain(`<a class="btn" href="/applications/${unknown.id}">Check</a>`);
  expect(needs).not.toContain(`/applications/${unknown.id}/hand-finish`);
  expect(needs).not.toContain("Co4");

  const rev = section(html, "Ready to review");
  expect(rev).toContain(`<a class="btn" href="/applications/${review.id}">Review</a>`);

  const next = section(html, "Up next");
  const order = [...next.matchAll(/href="\/applications\/([^"]+)">Intern/g)].map(m => m[1]);
  expect(order).toHaveLength(15);
  // The runner's order: newest posting first.
  const expected = [...queued].sort((a, b) => b.datePosted.getTime() - a.datePosted.getTime() || queued.indexOf(a) - queued.indexOf(b)).slice(0, 15).map(j => j.id);
  expect(order).toEqual(expected);
  expect(next).toContain('<a href="/applications?status=queued">View all</a>');

  const recent = section(html, "Recently submitted");
  expect([...recent.matchAll(/href="\/applications\/([^"]+)">Intern/g)]).toHaveLength(10);
  expect(recent).toContain(submitted[11]!.title);
  expect(html).not.toContain("Co60");
});

test("a job being finished by hand stays in its row as Applying now; a requested one says it is opening", async () => {
  const waiting = setup();
  const a = waiting.mk(1, "needs-you", "1 question needs you");
  const b = waiting.mk(2, "needs-you", "1 question needs you");
  setStatus(waiting.db, a.id, "filling");
  setRunnerCurrent(waiting.db, { jobId: a.id, step: "Waiting for you to finish and submit", startedAt: new Date().toISOString(), mode: "hand-finish" });
  const html = await get(waiting.app, "/home/lists");
  const needs = section(html, "Needs your input");
  expect(needs).toContain(`id="needs-row-${a.id}"`);
  expect(needs).toMatch(new RegExp(`needs-row-${a.id}[\\s\\S]*Applying now[\\s\\S]*needs-row-${b.id}`));

  const queued = setup([]);
  const c = queued.mk(3, "needs-you", "1 question needs you");
  const opening = createApp({ db: queued.db, llm: new FakeLlm(), runInteractive: vi.fn(), runReviewed: vi.fn(), runHandFinish: vi.fn(), pollNow: vi.fn(), requestedRuns: () => [c.id] });
  const text = await (await opening.request("/home/lists")).text();
  expect(text).toContain("Opening the application in a browser window…");
  expect(text).not.toContain(`/applications/${c.id}/hand-finish`);
});

test("the lists fragment is a bare, self-refreshing block", async () => {
  const { app } = setup();
  const frag = await get(app, "/home/lists");
  expect(frag).not.toContain("<html");
  expect(frag).toMatch(/^<div id="home-lists" hx-get="\/home\/lists" hx-trigger="every 10s" hx-swap="outerHTML">/);
  for (const t of ["Needs your input", "Ready to review", "Up next", "Recently submitted"]) expect(frag).toContain(`<h2>${t} `);
});

test("all job text on the dashboard is escaped", async () => {
  const { db, app, mk } = setup();
  const evil = '<img src=x onerror="alert(1)">';
  const j = mk(1, "needs-you", `Reason ${evil}`, { company: `Evil ${evil} Co`, title: `Title ${evil}`, locations: [`Loc ${evil}`] });
  mk(2, "queued", null, { company: `Q ${evil}`, title: `T ${evil}` });
  mk(3, "submitted", null, { company: `S ${evil}`, title: `T ${evil}` });
  mk(4, "ready-to-review", null, { company: `R ${evil}`, title: `T ${evil}` });
  setAts(db, j.id, `ats ${evil}`);
  setRunnerCurrent(db, { jobId: j.id, step: "Reading the form", startedAt: new Date().toISOString() });
  const html = await get(app, "/");
  expect(html).not.toContain(evil);
  expect(html).toContain("Title &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain("Reason &lt;img");
});

test("company avatars use initials and a stable color", () => {
  expect(initials("Jane Street")).toBe("JS");
  expect(initials("stripe")).toBe("S");
  expect(initials("  ")).toBe("?");
  expect(avatarColor("Stripe")).toBe(avatarColor("stripe "));
  expect(avatarColor("Stripe")).toMatch(/^#[0-9a-f]{6}$/);
});

test("POST /applications/:id/hand-finish starts the run only for a job waiting on the user's input", async () => {
  const { db, app, runHandFinish, mk } = setup();
  expect((await app.request("/applications/nope/hand-finish", { method: "POST" })).status).toBe(404);
  const ok = mk(1, "needs-you", "1 question needs you");
  const res = await app.request(`/applications/${ok.id}/hand-finish`, { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Opening the application in a browser window…");
  expect(runHandFinish).toHaveBeenCalledWith(ok.id);

  const captcha = mk(2, "needs-you", "CAPTCHA");
  addNeedsYou(db, { jobId: captcha.id, kind: "captcha", message: "solve" });
  const unknown = mk(3, "needs-you", "Submission state unknown — check before retrying");
  const byHand = mk(4, "needs-you", HAND_UNCONFIRMED);
  const queued = mk(5, "queued");
  for (const j of [captcha, unknown, byHand, queued])
    expect((await app.request(`/applications/${j.id}/hand-finish`, { method: "POST" })).status).toBe(409);
  expect(runHandFinish).toHaveBeenCalledTimes(1);
});

test("the job page offers Open & finish to a job waiting on the user's input", async () => {
  const { db, app, mk } = setup();
  const j = mk(1, "needs-you", "1 question needs you");
  expect(await get(app, `/applications/${j.id}`)).toContain(`hx-post="/applications/${j.id}/hand-finish"`);
  const c = mk(2, "needs-you", "CAPTCHA");
  addNeedsYou(db, { jobId: c.id, kind: "captcha", message: "solve" });
  const html = await get(app, `/applications/${c.id}`);
  expect(html).not.toContain("/hand-finish");
  expect(html).toContain("Do it now");
});
