import { chromium, type Browser, type Page } from "playwright";
import { addNeedsYou } from "../../src/answers/bank.js";
import { openDb, type Db } from "../../src/db/db.js";
import { getJob, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { Job } from "../../src/jobs/types.js";
import { saveProfile } from "../../src/profile/profile.js";
import { LiveService } from "../../src/runner/live.js";
import { runJob, type RunnerDeps } from "../../src/runner/runner.js";
import { SessionManager } from "../../src/runner/session-manager.js";
import { FakeLlm } from "./fake-llm.js";
import { miniAts, miniAtsHandler } from "./mini-ats-handler.js";

type C = Record<string, unknown>;
const CLASSES: Record<string, C> = {
  "First Name": { category: "profile", profileKey: "firstName", isFactual: true },
  Email: { category: "profile", profileKey: "email", isFactual: true },
  Phone: { category: "profile", profileKey: "phone", isFactual: true },
  "Are you willing to relocate?": { category: "profile", profileKey: "willingToRelocate", isFactual: true },
  "Tell us about a project you are proud of": { category: "question", canonicalQuestion: "Describe a project you are proud of.", isFactual: false },
  "I certify that the information above is accurate": { category: "consent-required" },
  "Text me about new roles": { category: "optin-optional" },
};

export const fakeLlm = () => new FakeLlm()
  .on("classify", (req: { content: unknown }) => ({
    fields: (JSON.parse(String(req.content)) as { fields: { id: string; label: string }[] }).fields.map(f => ({
      id: f.id, profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: false, isCompanySpecific: false, ...CLASSES[f.label],
    })),
  }))
  .on("match", () => ({ matchId: null, confidence: "low" }))
  .on("draft", () => ({ answerable: false, draft: null }))
  .on("fact", () => ({ answerable: false, answer: null, basis: null }));

/** A headless browser shared by a test file; every request the mini handler doesn't serve is aborted. */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}

/**
 * A database, a SessionManager whose shared context lives in `browser`, a LiveService polling every
 * 50ms, and runner deps using them. `pages` lists every page the manager handed out.
 */
export function liveSetup(browser: Browser, opts: { cap?: number } = {}) {
  const db: Db = openDb(":memory:");
  saveProfile(db, { firstName: "Luis", lastName: "Hernandez", email: "luis@example.com", phone: "5551234567", willingToRelocate: true });
  miniAts.reset();
  const pages: Page[] = [];
  const manager = new SessionManager({
    cap: opts.cap,
    launch: async () => {
      const ctx = await browser.newContext();
      await ctx.route("**/*", r => r.abort());
      ctx.on("page", p => pages.push(p));
      return ctx;
    },
    keepLastTab: false,
  });
  const submitted: string[] = [];
  const deps: RunnerDeps = {
    db, llm: fakeLlm(), browser: manager, handlers: [miniAtsHandler], pollMs: 50, now: () => new Date(), notify: async () => {},
    onSubmitted: id => { submitted.push(id); },
  };
  const live = new LiveService({
    db, manager, pollMs: 50, onSubmitted: id => { submitted.push(id); },
    runRebuild: async id => { await runJob(deps, id, "rebuild"); },
  });
  let seq = 0;
  const addJob = (url = "https://mini-ats.test/apply"): Job => {
    const { job } = upsertPosting(db, {
      sourceId: "test", listingId: String(++seq), company: "Mini Co", title: "Software Engineer Intern", locations: ["Austin, TX"],
      category: "Software", terms: ["Summer 2027"], degrees: [], sponsorship: null, url, datePosted: new Date(), active: true,
    });
    setStatus(db, job.id, "queued");
    return getJob(db, job.id)!;
  };
  /** A job whose relocation and phone questions only the user can answer, run once so it waits on the user. */
  const needsYouJob = async (url?: string): Promise<Job> => {
    saveProfile(db, { willingToRelocate: null, phone: null });
    const j = addJob(url);
    await runJob(deps, j.id);
    return getJob(db, j.id)!;
  };
  const markNeedsYou = (j: Job) => {
    setStatus(db, j.id, "needs-you", "2 questions need you");
    addNeedsYou(db, { jobId: j.id, kind: "other", message: "Mini Co · Software Engineer Intern: questions need you" });
  };
  const close = async () => { await live.stop(); await manager.close(); };
  return { db, manager, live, deps, pages, submitted, addJob, needsYouJob, markNeedsYou, close };
}

/** The center of the element in the page, in page pixels (what the live view sends). */
export async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Waits until `check` holds (polling), or throws after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}
