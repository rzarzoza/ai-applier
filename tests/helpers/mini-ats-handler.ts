import { readFileSync } from "node:fs";
import type { AtsHandler, OpenResult, SubmitOutcome } from "../../src/ats/types.js";
import { extractFields } from "../../src/forms/extract.js";
import { fillField, readBack } from "../../src/forms/fill.js";
import { inPage } from "../../src/forms/in-page.js";

const fixture = readFileSync(new URL("../fixtures/forms/mini-ats.html", import.meta.url), "utf8");
const FORM = "form#app";

/**
 * Test-only state of the fake site: what was actually POSTed by the page, and switches to make
 * `outcome` throw (as Playwright does when a navigation destroys the execution context) or `submit` throw.
 */
export const miniAts = {
  submissions: [] as Record<string, string>[],
  outcomeErrors: 0,
  /** Makes `submit` throw right after clicking (the click itself still goes through). */
  submitThrows: false,
  reset() {
    this.submissions = [];
    this.outcomeErrors = 0;
    this.submitThrows = false;
  },
};

export const fixtureSubmitCount = () => miniAts.submissions.length;

/** Paths that make `open` fail in each way an ATS handler can report. */
const OPEN_FAILURES: Record<string, OpenResult> = {
  "/closed": { ok: false, reason: "closed", detail: "job is no longer accepting applications" },
  "/gone": { ok: false, reason: "not-found", detail: "HTTP 404" },
  "/applied": { ok: false, reason: "already-applied", detail: "you already applied" },
  "/blocked": { ok: false, reason: "blocked", detail: "bot wall (HTTP 403)" },
};

type PageState = { thanks: boolean; captcha: boolean; oops: string | null; errors: string[] };

// Runs inside the page: must be self-contained.
function pageState(): PageState {
  const visible = (e: Element | null) => !!e && e.checkVisibility() && e.getClientRects().length > 0;
  const text = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const oops = document.getElementById("oops");
  return {
    thanks: visible(document.getElementById("thanks")),
    captcha: Array.from(document.querySelectorAll('iframe[title*="challenge"]')).some(visible),
    oops: visible(oops) ? text(oops) : null,
    errors: Array.from(document.querySelectorAll(".error")).filter(visible).map(text),
  };
}

/** An AtsHandler for `https://mini-ats.test/...` that serves tests/fixtures/forms/mini-ats.html offline. */
export const miniAtsHandler: AtsHandler = {
  name: "mini-ats",

  matches(url) {
    try { return new URL(url).hostname === "mini-ats.test"; } catch { return false; }
  },

  async open(page, url) {
    await page.context().route(/^https:\/\/mini-ats\.test\//, async route => {
      const req = route.request();
      if (req.method() === "POST" && new URL(req.url()).pathname === "/submit") {
        miniAts.submissions.push(JSON.parse(req.postData() ?? "{}") as Record<string, string>);
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      const body = new URL(req.url()).pathname === "/empty" ? "<form id='app'></form>" : fixture;
      return route.fulfill({ status: 200, contentType: "text/html", body });
    });
    const path = new URL(url).pathname;
    if (path === "/throw") throw new Error("net::ERR_CONNECTION_RESET");
    if (OPEN_FAILURES[path]) return OPEN_FAILURES[path];
    await page.goto(url);
    return { ok: true };
  },

  async root(page) {
    return page;
  },

  readFields(page) {
    return extractFields(page, FORM);
  },

  fill(page, field, answer) {
    return fillField(page, field, answer);
  },

  readBack(page, field) {
    return readBack(page, field);
  },

  async submit(page) {
    await page.locator("#submit").click();
    if (miniAts.submitThrows) throw new Error("Target page, context or browser has been closed");
  },

  async outcome(page): Promise<SubmitOutcome> {
    if (miniAts.outcomeErrors > 0) {
      miniAts.outcomeErrors--;
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    }
    const s = (await page.evaluate(inPage(pageState), undefined)) as PageState;
    if (s.thanks) return { kind: "submitted" };
    if (s.captcha) return { kind: "captcha" };
    if (s.errors.length) return { kind: "validation-error", messages: s.errors };
    if (s.oops) return { kind: "unknown", detail: s.oops };
    return { kind: "pending" };
  },

  async description(page) {
    return (await page.locator("#description").innerText()).trim() || undefined;
  },
};
