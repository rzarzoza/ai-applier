import path from "node:path";
import type { Page } from "playwright";
import { addBlocker, addNeedsYou, clearBlockersForJob, resolveNeedsYouForJob } from "../answers/bank.js";
import { normalizeLabel } from "../answers/classify.js";
import { resolveFields, type FillSource, type Preset, type Resolution } from "../answers/resolve.js";
import { atsNameFromUrl, detectAts, HANDLERS } from "../ats/registry.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "../ats/types.js";
import type { Db } from "../db/db.js";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import {
  decrementAttempts, getJob, incrementAttempts, isUnknownSubmission, nextQueued, RESUME_NEEDED, setAts, setStatus, setUsedDocuments,
  submittedSince, UNKNOWN_SUBMISSION,
} from "../jobs/repo.js";
import type { Job, JobStatus } from "../jobs/types.js";
import { llmHaltReason, type Llm } from "../llm/llm.js";
import { getFilters } from "../filters/filters.js";
import { getSettings, haltRunner, type Settings } from "../settings.js";
import { recheckQueued } from "../sources/poller.js";
import type { BrowserProvider } from "./browser.js";
import { getSnapshot, saveRecord, saveSnapshot, type Snapshot } from "./records.js";

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
  /** Called after a job ends submitted or applied-manually (e.g. to sync the tracker). Must not block; errors are ignored. */
  onSubmitted?(jobId: string): void;
  /** Whether an Anthropic API key is available; when it says no, `runNext` pauses instead of taking a job. */
  hasApiKey?(): Promise<boolean>;
}

/** A problem outside the job (the browser can't start) that would fail every job the same way. */
class SetupError extends Error {}

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

/** Statuses a run must never touch again: the job is done, or the user set it aside. */
const FINAL: ReadonlySet<JobStatus> = new Set(["submitted", "applied-manually", "closed", "skipped", "duplicate-role"]);
/** New questions can appear after answers (conditional fields); fill at most this many extra rounds. */
const MAX_EXTRA_ROUNDS = 3;

const isHuman = (o: SubmitOutcome) => o.kind === "captcha" || o.kind === "verification-code";

/**
 * Applies to one job: opens its form through the matching ATS handler, resolves and fills every
 * field (and any questions the answers reveal), verifies the values, then stops for review, for the
 * user's input, or submits. Never submits while a required field, a draft, or a CAPTCHA/code is
 * unresolved. Always leaves the job in a final status with a reason, and closes the browser page.
 * Jobs already done or set aside are left untouched; "submit-reviewed" only runs a job awaiting review,
 * and "interactive" never re-runs a job whose application may already have been sent.
 */
export async function runJob(deps: RunnerDeps, jobId: string, mode: RunMode = "auto"): Promise<JobStatus> {
  const { db } = deps;
  const job = getJob(db, jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);
  if (FINAL.has(job.status)) return job.status;
  if (mode === "submit-reviewed" && job.status !== "ready-to-review") return job.status;
  // Only the confirmed Retry on the job's page may re-run a possibly sent application.
  if (mode === "interactive" && isUnknownSubmission(job)) return job.status;

  clearBlockersForJob(db, job.id);
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

  // The user is at the browser in these modes: show it and wait longer for them.
  const userPresent = mode !== "auto";
  let session: { page: Page; close(): Promise<void> } | null = null;
  const fields: FieldSpec[] = [];
  const resolutions: Resolution[] = [];
  const byId = new Map<string, FieldSpec>();
  let submitClicked = false;
  let beforeSubmit: Buffer | null = null;
  // Submitting after review sends exactly what the user reviewed; anything else goes back for review.
  const reviewed = mode === "submit-reviewed" ? reviewedValues(getSnapshot(db, job.id)) : null;

  /**
   * Saves what this run saw (with a screenshot) and sets the final status. A job that no longer needs
   * the user has its open needs-you items resolved; needs-you endings add their own item first.
   */
  const end = async (status: JobStatus, reason: string | null, shot?: Buffer | null): Promise<JobStatus> => {
    if (session) {
      try {
        saveSnapshot(db, job.id, { fields, resolutions, screenshot: shot ?? (await screenshot(session.page)) });
      } catch { /* a missing snapshot must not hide the status */ }
    }
    if (status !== "needs-you") {
      try { resolveNeedsYouForJob(db, job.id); } catch { /* the status below still stands */ }
    }
    setStatus(db, job.id, status, reason);
    if (status === "applied-manually") notifySubmitted();
    return status;
  };

  const notifySubmitted = () => {
    try { deps.onSubmitted?.(job.id); } catch { /* the tracker must never affect a job */ }
  };

  /** Records a confirmed submission. A record that can't be written never changes the status. */
  const endSubmitted = async (page: Page): Promise<JobStatus> => {
    const confirmation = await screenshot(page);
    let reason: string | null = null;
    try {
      saveRecord(job.id, {
        screenshots: [beforeSubmit, confirmation].filter((s): s is Buffer => s !== null),
        answers: resolutions.filter((r): r is Filled => r.status === "filled")
          .map(r => ({ label: byId.get(r.fieldId)!.label, value: answerValue(r.answer), source: r.source })),
        outcome: "submitted",
      });
    } catch (err) {
      reason = `Submitted, but the record could not be saved: ${errorMessage(err)}`;
    }
    try {
      const docs = usedDocuments(fields, resolutions);
      setUsedDocuments(db, job.id, docs.resume, docs.coverLetter);
    } catch { /* the tracker columns are a convenience */ }
    const status = await end("submitted", reason, confirmation);
    notifySubmitted();
    return status;
  };

  /** The application may already have gone out: flag it for the user and never invite a blind retry. */
  const endUnknown = (detail: string): Promise<JobStatus> => {
    try {
      resolveNeedsYouForJob(db, job.id);
      addNeedsYou(db, { jobId: job.id, kind: "other", message: `${job.company} · ${job.title}: ${UNKNOWN_SUBMISSION} (${detail})` });
    } catch { /* the status below still flags it */ }
    return end("needs-you", UNKNOWN_SUBMISSION);
  };

  try {
    const settings = getSettings(db);
    try {
      session = await deps.browser.open({ headless: userPresent ? false : settings.headless });
    } catch (err) {
      throw new SetupError(`The browser could not start: ${errorMessage(err)}`);
    }
    const { page } = session;

    const opened = await handler.open(page, job.url);
    if (!opened.ok) return await end(...OPEN_FAILED[opened.reason](opened.detail));

    let batch = await handler.readFields(page);
    if (!batch.length) return await end("failed", "No form fields found");
    const ctx = await jobContext(job, handler, page);
    let present = batch;

    for (let round = 0; ; round++) {
      for (const f of batch) { fields.push(f); byId.set(f.id, f); }
      const res = await resolveFields({ db, llm: deps.llm }, batch, ctx, reviewed?.preset);
      resolutions.push(...res);

      const files = res.filter(r => r.status === "needs-file");
      const otherFile = files.find(r => !r.resume);
      if (otherFile) return await end("failed", `Needs a file upload: "${byId.get(otherFile.fieldId)!.label}" — apply manually or skip`);
      if (files.length) {
        resolveNeedsYouForJob(db, job.id);
        addNeedsYou(db, { jobId: job.id, kind: "other", message: `${job.company} · ${job.title}: ${RESUME_NEEDED}` });
        return await end("needs-you", RESUME_NEEDED);
      }

      const blocked = res.filter(r => r.status === "blocked");
      if (blocked.length) {
        for (const b of blocked) addBlocker(db, job.id, b.questionId, b.reason);
        resolveNeedsYouForJob(db, job.id); // this run supersedes any earlier CAPTCHA or code request
        const n = new Set(blocked.map(b => b.questionId)).size;
        return await end("needs-you", n === 1 ? "1 question needs you" : `${n} questions need you`);
      }
      const unanswered = res.find(r => r.status === "skip" && byId.get(r.fieldId)?.required);
      if (unanswered) return await end("failed", `Required field "${byId.get(unanswered.fieldId)!.label}" has no answer`);

      for (const r of res) if (r.status === "filled") await handler.fill(page, byId.get(r.fieldId)!, r.answer);

      // Answers can reveal follow-up questions; read the form again and handle any new ones.
      present = await handler.readFields(page);
      batch = present.filter(f => !byId.has(f.id));
      if (!batch.length) break;
      if (round === MAX_EXTRA_ROUNDS) {
        const extra = batch.find(f => f.required);
        if (extra) return await end("failed", `New required questions kept appearing (last: "${extra.label}")`);
        break;
      }
    }

    // Verify the fields still on the form (a conditional question may have been removed again).
    const onForm = new Set(present.map(f => f.id));
    for (const r of resolutions) {
      if (r.status !== "filled" || !onForm.has(r.fieldId)) continue;
      const field = byId.get(r.fieldId)!;
      const got = await handler.readBack(page, field);
      // A blank optional field is allowed; a required one, or a field holding some other value, is not.
      if (!holds(field, r.answer, got) && (field.required || !isEmpty(got))) return await end("failed", `Could not fill "${field.label}"`);
    }

    if (reviewed) {
      const unseen = resolutions.some(r => r.status === "filled" && r.source !== "override" && !reviewed.includes(byId.get(r.fieldId)!, r.answer));
      if (unseen) return await end("ready-to-review", "Form changed since review");
    } else if (reviewApplies(settings, job.company)) return await end("ready-to-review", "Waiting for your review");

    if (dailyLimitReached(db, settings, deps.now())) {
      setStatus(db, job.id, "queued", "Daily limit reached");
      return "queued";
    }

    beforeSubmit = await screenshot(page);
    submitClicked = true;
    await handler.submit(page);
    const pollMs = deps.pollMs ?? POLL_MS;
    let outcome = await pollOutcome(handler, page, deps.submitWaitMs ?? SUBMIT_WAIT_MS, pollMs, o => o.kind === "pending");

    if (outcome.kind === "captcha" || outcome.kind === "verification-code") {
      const step = HUMAN[outcome.kind];
      await deps.notify("AI Applier needs you", `${job.company}: ${step.ask} in the browser window`);
      resolveNeedsYouForJob(db, job.id);
      addNeedsYou(db, { jobId: job.id, kind: step.kind, message: `${job.company} · ${job.title}: ${step.ask}` });
      // Nobody can solve anything in a hidden browser: hand it to the user right away.
      if (!userPresent && settings.headless) return await end("needs-you", step.reason);
      const humanWait = deps.humanWaitMs ?? HUMAN_WAIT_MS;
      outcome = await pollOutcome(handler, page, userPresent ? Math.max(humanWait, INTERACTIVE_WAIT_MS) : humanWait, pollMs,
        o => o.kind === "pending" || isHuman(o));
      // The user may have solved it and sent the form without the page confirming: never invite a blind retry.
      if (page.isClosed()) return await endUnknown(`The browser window was closed during the ${step.reason.toLowerCase()} wait`);
      if (isHuman(outcome)) return await end("needs-you", step.reason);
      if (outcome.kind === "pending") return await endUnknown(`No confirmation after the ${step.reason.toLowerCase()} wait`);
      resolveNeedsYouForJob(db, job.id);
    }

    switch (outcome.kind) {
      case "submitted":
        return await endSubmitted(page);
      case "validation-error":
        return await end("failed", outcome.messages.join("; ") || "The form reported an error");
      case "already-applied":
        return await end("applied-manually", "Already applied");
      case "unknown":
        return await endUnknown(outcome.detail);
      default:
        return await endUnknown("No confirmation after submitting");
    }
  } catch (err) {
    const halt = err instanceof SetupError ? err.message : llmHaltReason(err);
    if (halt && !submitClicked) {
      // Every job would fail the same way: put this one back as it was and pause until it's fixed.
      setStatus(db, job.id, job.status, job.statusReason);
      decrementAttempts(db, job.id);
      haltRunner(db, halt, deps.now());
      return job.status;
    }
    if (!submitClicked || !session) return await end("failed", errorMessage(err));
    const outcome = await handler.outcome(session.page).catch((): SubmitOutcome => ({ kind: "pending" }));
    if (outcome.kind === "submitted") return await endSubmitted(session.page);
    return await endUnknown(errorMessage(err));
  } finally {
    await session?.close().catch(() => {});
  }
}

/**
 * A job left "filling" means the app stopped mid-run (Ctrl-C, crash), possibly after clicking submit.
 * Flags each one as state unknown, so only the confirmed Retry on its page runs it again. Call at
 * startup, before any run. Returns the flagged job ids.
 */
export function flagInterruptedRuns(db: Db): string[] {
  const rows = db.prepare("SELECT id, company, title FROM jobs WHERE status = 'filling' ORDER BY rowid").all() as unknown as { id: string; company: string; title: string }[];
  for (const j of rows) {
    resolveNeedsYouForJob(db, j.id);
    addNeedsYou(db, { jobId: j.id, kind: "other", message: `${j.company} · ${j.title}: ${UNKNOWN_SUBMISSION} (the app stopped during this application)` });
    setStatus(db, j.id, "needs-you", UNKNOWN_SUBMISSION);
  }
  return rows.map(j => j.id);
}

/**
 * Runs the next queued job that still passes the filters (skipping the ones that don't), unless the
 * runner is paused, the queue is empty, or today's limit is reached. With no API key available it
 * pauses the runner instead of taking a job.
 */
export async function runNext(deps: RunnerDeps): Promise<JobStatus | null> {
  const settings = getSettings(deps.db);
  if (settings.paused) return null;
  // Filters may have changed since the job was queued: skip any that no longer pass.
  const rules = getFilters(deps.db);
  let job = nextQueued(deps.db);
  while (job && !recheckQueued(deps.db, job, rules, deps.now())) job = nextQueued(deps.db);
  if (!job) return null;
  if (dailyLimitReached(deps.db, settings, deps.now())) return null;
  if (deps.hasApiKey && !(await deps.hasApiKey())) {
    haltRunner(deps.db, "Add your Anthropic API key in Settings", deps.now());
    return null;
  }
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

/**
 * The values the user reviewed, by field label: `preset` gives a field its reviewed value (when its
 * label had exactly one), and `includes` says whether a value is one the user saw for that label.
 */
function reviewedValues(snap: Snapshot | null): { preset: Preset; includes(field: FieldSpec, answer: FieldAnswer): boolean } {
  const byLabel = new Map<string, { answer: FieldAnswer; source: FillSource }[]>();
  const labels = new Map((snap?.fields ?? []).map(f => [f.id, f.label]));
  for (const r of snap?.resolutions ?? []) {
    const label = labels.get(r.fieldId);
    if (r.status !== "filled" || label === undefined) continue;
    const key = normalizeLabel(label, "");
    byLabel.set(key, [...(byLabel.get(key) ?? []), { answer: r.answer, source: r.source }]);
  }
  const seen = (field: FieldSpec) => byLabel.get(normalizeLabel(field.label, "")) ?? [];
  return {
    preset: field => {
      const values = seen(field);
      return values.length > 0 && values.every(v => sameAnswer(v.answer, values[0]!.answer)) ? values[0] : undefined;
    },
    includes: (field, answer) => seen(field).some(v => sameAnswer(v.answer, answer)),
  };
}

function sameAnswer(a: FieldAnswer, b: FieldAnswer): boolean {
  return JSON.stringify(answerValue(a)) === JSON.stringify(answerValue(b)) && a.type === b.type;
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

/**
 * Polls the outcome every `pollMs` while `keepWaiting` holds, for up to `waitMs`, stopping early if
 * the page is closed. A check that throws counts as pending.
 */
async function pollOutcome(handler: AtsHandler, page: Page, waitMs: number, pollMs: number, keepWaiting: (o: SubmitOutcome) => boolean): Promise<SubmitOutcome> {
  const check = () => handler.outcome(page).catch((): SubmitOutcome => ({ kind: "pending" }));
  const deadline = Date.now() + waitMs;
  let out = await check();
  while (keepWaiting(out) && Date.now() < deadline && !page.isClosed()) {
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

/** The resume file the form got, and the cover letter: a file's name, "written answer" for text, or "none". */
export function usedDocuments(fields: FieldSpec[], resolutions: Resolution[]): { resume: string | null; coverLetter: string } {
  const byId = new Map(fields.map(f => [f.id, f]));
  let resume: string | null = null;
  let coverFile: string | null = null;
  let coverText = false;
  for (const r of resolutions) {
    if (r.status !== "filled") continue;
    if (r.source === "resume" && r.answer.type === "file") resume ??= path.basename(r.answer.path);
    if (!/cover letter/i.test(byId.get(r.fieldId)?.label ?? "")) continue;
    if (r.answer.type === "file") coverFile ??= path.basename(r.answer.path);
    else if (r.answer.type === "text" && r.answer.text.trim()) coverText = true;
  }
  return { resume, coverLetter: coverFile ?? (coverText ? "written answer" : "none") };
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
