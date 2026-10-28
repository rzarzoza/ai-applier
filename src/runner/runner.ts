import type { Page } from "playwright";
import { addBlocker, addNeedsYou, resolveNeedsYouForJob } from "../answers/bank.js";
import { resolveFields, type Resolution } from "../answers/resolve.js";
import { atsNameFromUrl, detectAts, HANDLERS } from "../ats/registry.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "../ats/types.js";
import type { Db } from "../db/db.js";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import { getJob, incrementAttempts, nextQueued, setAts, setStatus, submittedSince } from "../jobs/repo.js";
import type { Job, JobStatus } from "../jobs/types.js";
import type { Llm } from "../llm/llm.js";
import { getSettings, type Settings } from "../settings.js";
import type { BrowserProvider } from "./browser.js";
import { saveRecord, saveSnapshot } from "./records.js";

export interface RunnerDeps {
  db: Db;
  llm: Llm;
  browser: BrowserProvider;
  notify(title: string, message: string): Promise<void>;
  now(): Date;
  handlers?: AtsHandler[];
  /** How long to wait for the user to clear a CAPTCHA or verification code. */
  humanWaitMs?: number; // default 600_000
  pollMs?: number; // default 5_000
  /** How long to wait for the page to confirm a submission. */
  submitWaitMs?: number; // default 30_000
}

export type RunMode = "auto" | "submit-reviewed" | "interactive";

const HUMAN_WAIT_MS = 600_000;
const POLL_MS = 5_000;
const SUBMIT_WAIT_MS = 30_000;
/** In interactive mode the user is at the browser, so wait much longer for them. */
const INTERACTIVE_WAIT_MS = 60 * 60_000;

type Filled = Extract<Resolution, { status: "filled" }>;
type HumanStep = Extract<SubmitOutcome, { kind: "captcha" | "verification-code" }>["kind"];

const HUMAN: Record<HumanStep, { reason: string; kind: "captcha" | "code"; ask: string }> = {
  captcha: { reason: "CAPTCHA", kind: "captcha", ask: "solve the CAPTCHA" },
  "verification-code": { reason: "Verification code", kind: "code", ask: "enter the verification code" },
};

const OPEN_FAILED: Record<Extract<OpenResult, { ok: false }>["reason"], (detail?: string) => [JobStatus, string]> = {
  closed: d => ["closed", d ?? "Posting is closed"],
  "not-found": d => ["failed", d ?? "Posting not found"],
  "already-applied": d => ["applied-manually", d ?? "Already applied"],
  blocked: d => ["failed", `Blocked: ${d ?? "the site refused the browser"}`],
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const errorMessage = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim() || "Unexpected error";

/**
 * Applies to one job: opens its form through the matching ATS handler, resolves and fills every
 * field, verifies the values, then stops for review, for the user's input, or submits. Never submits
 * while a required field, a draft, or a CAPTCHA/code is unresolved. Always leaves the job in a final
 * status with a reason, and closes the browser page.
 */
export async function runJob(deps: RunnerDeps, jobId: string, mode: RunMode = "auto"): Promise<JobStatus> {
  const { db } = deps;
  const job = getJob(db, jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);

  const handler = detectAts(job.url, deps.handlers ?? HANDLERS);
  if (!handler) {
    const ats = atsNameFromUrl(job.url);
    setAts(db, job.id, ats);
    setStatus(db, job.id, "unsupported", ats);
    return "unsupported";
  }
  setAts(db, job.id, handler.name);
  setStatus(db, job.id, "filling");
  incrementAttempts(db, job.id);

  const settings = getSettings(db);
  let session: { page: Page; close(): Promise<void> } | null = null;
  let fields: FieldSpec[] = [];
  let resolutions: Resolution[] = [];

  /** Saves what this run saw (with a screenshot) and sets the final status. */
  const end = async (status: JobStatus, reason: string | null, shot?: Buffer | null): Promise<JobStatus> => {
    if (session) {
      try {
        saveSnapshot(db, job.id, { fields, resolutions, screenshot: shot ?? (await screenshot(session.page)) });
      } catch { /* a missing snapshot must not hide the status */ }
    }
    setStatus(db, job.id, status, reason);
    return status;
  };

  try {
    session = await deps.browser.open({ headless: mode === "interactive" ? false : settings.headless });
    const { page } = session;

    const opened = await handler.open(page, job.url);
    if (!opened.ok) return await end(...OPEN_FAILED[opened.reason](opened.detail));

    fields = await handler.readFields(page);
    if (!fields.length) return await end("failed", "No form fields found");

    resolutions = await resolveFields({ db, llm: deps.llm }, fields, await jobContext(job, handler, page));

    const blocked = resolutions.filter(r => r.status === "blocked");
    if (blocked.length) {
      for (const b of blocked) addBlocker(db, job.id, b.questionId, b.reason);
      return await end("needs-you", `${new Set(blocked.map(b => b.questionId)).size} questions need you`);
    }

    const byId = new Map(fields.map(f => [f.id, f]));
    const unanswered = resolutions.find(r => r.status === "skip" && byId.get(r.fieldId)?.required);
    if (unanswered) return await end("failed", `Required field "${byId.get(unanswered.fieldId)!.label}" has no answer`);

    const filled = resolutions.filter((r): r is Filled => r.status === "filled");
    for (const r of filled) await handler.fill(page, byId.get(r.fieldId)!, r.answer);
    for (const r of filled) {
      const field = byId.get(r.fieldId)!;
      const got = await handler.readBack(page, field);
      // A blank optional field is allowed; a required one, or a field holding some other value, is not.
      if (!holds(field, r.answer, got) && (field.required || !isEmpty(got))) return await end("failed", `Could not fill "${field.label}"`);
    }

    if (mode === "auto" && reviewApplies(settings, job.company)) return await end("ready-to-review", "Waiting for your review");

    if (dailyLimitReached(db, settings, deps.now())) {
      setStatus(db, job.id, "queued", "Daily limit reached");
      return "queued";
    }

    const beforeSubmit = await screenshot(page);
    await handler.submit(page);
    const pollMs = deps.pollMs ?? POLL_MS;
    let outcome = await pollOutcome(handler, page, deps.submitWaitMs ?? SUBMIT_WAIT_MS, pollMs, o => o.kind === "pending");

    if (outcome.kind === "captcha" || outcome.kind === "verification-code") {
      const step = HUMAN[outcome.kind];
      await deps.notify("AI Applier needs you", `${job.company}: ${step.ask} in the browser window`);
      resolveNeedsYouForJob(db, job.id);
      addNeedsYou(db, { jobId: job.id, kind: step.kind, message: `${job.company} · ${job.title}: ${step.ask}` });
      const humanWait = mode === "interactive" ? Math.max(deps.humanWaitMs ?? HUMAN_WAIT_MS, INTERACTIVE_WAIT_MS) : deps.humanWaitMs ?? HUMAN_WAIT_MS;
      outcome = await pollOutcome(handler, page, humanWait, pollMs, o => o.kind === "pending" || o.kind === "captcha" || o.kind === "verification-code");
      if (outcome.kind === "pending" || outcome.kind === "captcha" || outcome.kind === "verification-code") return await end("needs-you", step.reason);
      resolveNeedsYouForJob(db, job.id);
    }

    switch (outcome.kind) {
      case "submitted": {
        const confirmation = await screenshot(page);
        saveRecord(job.id, {
          screenshots: [beforeSubmit, confirmation].filter((s): s is Buffer => s !== null),
          answers: filled.map(r => ({ label: byId.get(r.fieldId)!.label, value: answerValue(r.answer), source: r.source })),
          outcome: "submitted",
        });
        return await end("submitted", null, confirmation);
      }
      case "validation-error":
        return await end("failed", outcome.messages.join("; ") || "The form reported an error");
      case "already-applied":
        return await end("applied-manually", "Already applied");
      case "unknown":
        return await end("failed", outcome.detail);
      default:
        return await end("failed", "No confirmation after submitting");
    }
  } catch (err) {
    return await end("failed", errorMessage(err));
  } finally {
    await session?.close().catch(() => {});
  }
}

/** Runs the next queued job, unless the runner is paused, the queue is empty, or today's limit is reached. */
export async function runNext(deps: RunnerDeps): Promise<JobStatus | null> {
  const settings = getSettings(deps.db);
  if (settings.paused) return null;
  const job = nextQueued(deps.db);
  if (!job) return null;
  if (dailyLimitReached(deps.db, settings, deps.now())) return null;
  return runJob(deps, job.id, "auto");
}

async function jobContext(job: Job, handler: AtsHandler, page: Page): Promise<JobContext> {
  return {
    jobId: job.id, company: job.company, title: job.title,
    location: job.chosenLocation ?? job.locations[0] ?? "",
    term: job.terms[0] ?? null,
    description: await handler.description(page).catch(() => undefined),
  };
}

function reviewApplies(s: Settings, company: string): boolean {
  const c = company.trim().toLowerCase();
  return s.reviewMode === "all" || (s.reviewMode === "companies" && s.reviewCompanies.some(x => x.trim().toLowerCase() === c));
}

function dailyLimitReached(db: Db, s: Settings, now: Date): boolean {
  if (s.dailyLimit === null) return false;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return submittedSince(db, startOfDay) >= s.dailyLimit;
}

/** Polls the outcome every `pollMs` while `keepWaiting` holds, for up to `waitMs`. A check that throws counts as pending. */
async function pollOutcome(handler: AtsHandler, page: Page, waitMs: number, pollMs: number, keepWaiting: (o: SubmitOutcome) => boolean): Promise<SubmitOutcome> {
  const check = () => handler.outcome(page).catch((): SubmitOutcome => ({ kind: "pending" }));
  const deadline = Date.now() + waitMs;
  let out = await check();
  while (keepWaiting(out) && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    out = await check();
  }
  return out;
}

const screenshot = (page: Page): Promise<Buffer | null> => page.screenshot({ fullPage: true }).catch(() => null);

const TEXT_KINDS = new Set<FieldSpec["kind"]>(["text", "textarea", "email", "tel", "url", "number", "date"]);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const lower = (xs: string[]) => xs.map(x => squash(x).toLowerCase()).sort();

function isEmpty(got: string | string[] | boolean | null): boolean {
  return got === null || got === false || (typeof got === "string" && got.trim() === "") || (Array.isArray(got) && got.length === 0);
}

/**
 * Whether the value read back from the page is the answer that was filled. Text inputs must hold the
 * same text (phone numbers compared without formatting); choices only need some selection, since a
 * widget may show a different label for the chosen option (e.g. a dial code for a phone country).
 */
function holds(field: FieldSpec, answer: FieldAnswer, got: string | string[] | boolean | null): boolean {
  switch (answer.type) {
    case "check":
      return got === answer.checked;
    case "options":
      return Array.isArray(got) && JSON.stringify(lower(got)) === JSON.stringify(lower(answer.options));
    case "text":
      if (TEXT_KINDS.has(field.kind)) {
        if (typeof got !== "string") return false;
        if (field.kind === "tel") return got.replace(/[^0-9a-z+]/gi, "") === answer.text.replace(/[^0-9a-z+]/gi, "");
        return squash(got) === squash(answer.text);
      }
      return !isEmpty(got);
    default:
      return !isEmpty(got);
  }
}

function answerValue(a: FieldAnswer): unknown {
  switch (a.type) {
    case "text": return a.text;
    case "option": return a.option;
    case "options": return a.options;
    case "check": return a.checked;
    case "file": return a.path;
  }
}
