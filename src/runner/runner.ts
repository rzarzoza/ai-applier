import path from "node:path";
import type { Frame, Page, Request } from "playwright";
import { addBlocker, addNeedsYou, clearBlockersForJob, getOverrides, getQuestion, resolveNeedsYouForJob } from "../answers/bank.js";
import { adaptAnswer, nameVariants, pickOption } from "../answers/adapt.js";
import { degreeInProgress, degreeQueries, pickDegree } from "../answers/degree.js";
import { normalizeLabel, withCompanyPlaceholder } from "../answers/classify.js";
import { answerQuestion, canHandFinish } from "../answers/inbox.js";
import { distinctiveWords, findOtherOption, followUpBox, looksLikeFollowUp, otherEligible } from "../answers/other.js";
import { resolveFields, type Extra, type FillSource, type Preset, type Resolution } from "../answers/resolve.js";
import { atsNameFromUrl, detectAts, HANDLERS } from "../ats/registry.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "../ats/types.js";
import type { Db } from "../db/db.js";
import { readOptions as readOptionsField } from "../forms/fill.js";
import { inPage } from "../forms/in-page.js";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import {
  canOpenLive, decrementAttempts, getJob, HAND_UNCONFIRMED, incrementAttempts, isUnknownSubmission, nextQueued, PAUSED_MID_RUN, RESUME_NEEDED, setAts, setStatus,
  setUsedDocuments, submittedSince, UNKNOWN_SUBMISSION,
} from "../jobs/repo.js";
import type { Job, JobStatus } from "../jobs/types.js";
import { llmHaltReason, type Llm } from "../llm/llm.js";
import { withAiScope } from "../llm/meter.js";
import { getFilters } from "../filters/filters.js";
import { getProfile } from "../profile/profile.js";
import { getSettings, haltRunner, type Settings } from "../settings.js";
import { recheckQueued } from "../sources/poller.js";
import type { JobLocks } from "../scheduler.js";
import type { BrowserProvider, BrowserSession, WatchField } from "./browser.js";
import { clearRunnerCurrent, getRunnerCurrent, setRunnerCurrent, STEPS, type RunnerCurrent, type RunnerStep } from "./current.js";
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
  /** In "hand-finish" mode, how long to wait for the user to complete the form and submit it. */
  handFinishWaitMs?: number; // default 30 minutes
  /** Called after a job ends submitted or applied-manually (e.g. to sync the tracker). Must not block; errors are ignored. */
  onSubmitted?(jobId: string): void;
  /** Whether an Anthropic API key is available; when it says no, `runNext` pauses instead of taking a job. */
  hasApiKey?(): Promise<boolean>;
  /** Keeps two runs off the same job (a rebuild runs beside the queue's run). Without it, the caller keeps them apart. */
  locks?: JobLocks;
}

/** What a run may be told while it runs. */
export interface RunOptions {
  /** Aborting stops the run: its page is closed (so whatever it awaits on the page fails) and nothing is parked. */
  signal?: AbortSignal;
}

/** Why a rebuild did not start: another run (Open & finish, Do it now, Submit...) has the job right now. */
export const JOB_BUSY = "This application is being worked on in another run — try again once it's done";

/** Thrown between fields or before submitting once the runner was paused during an auto run (see runJob). */
class PausedStop extends Error {}

/** A problem outside the job (the browser can't start) that would fail every job the same way. */
class SetupError extends Error {}

/**
 * "hand-finish" opens the form of a job waiting on the user, fills what the app can, highlights what is left, and waits
 * for the user to finish and click the site's own submit button: the app never submits in this mode.
 * "rebuild" opens the form of a job waiting on the user (or on review) again for the dashboard's live view: it fills
 * everything the app knows (the user's per-job values first), highlights what is left and parks the page. It never
 * submits, never waits, and never changes the job's status; a failure is thrown.
 */
export type RunMode = "auto" | "submit-reviewed" | "interactive" | "hand-finish" | "rebuild";

const HUMAN_WAIT_MS = 600_000;
const POLL_MS = 5_000;
const SUBMIT_WAIT_MS = 30_000;
/** In interactive mode the user is at the browser, so wait much longer for them. */
const INTERACTIVE_WAIT_MS = 60 * 60_000;
/** How long "hand-finish" waits for the user to submit, and how often it checks the page meanwhile. */
const HAND_FINISH_WAIT_MS = 30 * 60_000;
const HAND_POLL_MS = 3_000;
/** The needs-you reason of a hand-finish run whose window was closed (or timed out) before anything was sent. */
export const CLOSED_BEFORE_SUBMITTING = "Closed before submitting";

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

/** A field that could not be filled, and a short reason why. */
type FillFailure = { field: FieldSpec; reason: string };
const OPTION_KINDS = new Set<FieldSpec["kind"]>(["select", "combobox", "radio"]);
/** A fill error meaning the control offers no option matching the answer (or several equally). */
const NO_OPTION = /no (combobox )?option|ambiguous option/i;
const REASON_MAX = 160;
const shortReason = (err: unknown) => {
  const m = errorMessage(err);
  return m.length > REASON_MAX ? `${m.slice(0, REASON_MAX - 1)}…` : m;
};
const couldNotFill = (f: { field: FieldSpec; reason?: string }) =>
  f.reason ? `Could not fill "${f.field.label}": ${f.reason}` : `Could not fill "${f.field.label}"`;

/**
 * Applies to one job: opens its form through the matching ATS handler, resolves and fills every
 * field (and any questions the answers reveal), verifies the values, then stops for review, for the
 * user's input, or submits. A job stopped for questions that need the user still has every answered
 * field filled first (resume upload first), so its screenshot shows what is left. Never submits while a required field, a draft, or a CAPTCHA/code is
 * unresolved. Always leaves the job in a final status with a reason, and closes the browser page.
 * Jobs already done or set aside are left untouched; "submit-reviewed" only runs a job awaiting review,
 * and "interactive" never re-runs a job whose application may already have been sent. "hand-finish" only runs a job
 * that canHandFinish allows, and leaves the submitting to the user (see awaitHandFinish below).
 * While it runs, the job and its current step are kept in kv `runnerCurrent` for the dashboard.
 */
export async function runJob(deps: RunnerDeps, jobId: string, mode: RunMode = "auto", opts: RunOptions = {}): Promise<JobStatus> {
  // Every AI call of this run is metered against the job (its cost shows on the job's page).
  return (await withAiScope(jobId, () => runJobLocked(deps, jobId, mode, opts))).result;
}

async function runJobLocked(deps: RunnerDeps, jobId: string, mode: RunMode, opts: RunOptions): Promise<JobStatus> {
  const locks = deps.locks;
  if (!locks) return runLocked(deps, jobId, mode, opts);
  // A rebuild never waits: the job is someone else's right now. Any other run waits for a rebuild of its job to end.
  const release = mode === "rebuild" ? locks.tryAcquire(jobId) : await locks.acquire(jobId);
  if (!release) throw new Error(JOB_BUSY);
  try {
    return await runLocked(deps, jobId, mode, opts);
  } finally {
    release();
  }
}

/**
 * runJob, holding the job's lock. An auto run checks the runner's Paused switch between fields and before submitting:
 * once paused, it stops there and leaves the job waiting on the user (PAUSED_MID_RUN) with its tab parked as filled so
 * far; resuming the runner queues it again (see resumeRunner).
 */
async function runLocked(deps: RunnerDeps, jobId: string, mode: RunMode, opts: RunOptions): Promise<JobStatus> {
  const { db } = deps;
  const { signal } = opts;
  const job = getJob(db, jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);
  if (FINAL.has(job.status)) return job.status;
  if (mode === "submit-reviewed" && job.status !== "ready-to-review") return job.status;
  // Only the confirmed Retry on the job's page may re-run a possibly sent application.
  if (mode === "interactive" && isUnknownSubmission(job)) return job.status;
  if (mode === "hand-finish" && !canHandFinish(db, job.id)) return job.status;
  const rebuild = mode === "rebuild";
  if (rebuild && !canOpenLive(job)) return job.status;

  // A rebuild leaves the job as it is: its blockers stay until a run or a submission replaces them.
  if (!rebuild) clearBlockersForJob(db, job.id);
  const handler = detectAts(job.url, deps.handlers ?? HANDLERS);
  if (!handler) {
    if (rebuild) throw new Error(`${atsNameFromUrl(job.url)} forms can't be opened here`);
    const ats = atsNameFromUrl(job.url);
    setAts(db, job.id, ats);
    setStatus(db, job.id, "unsupported", ats);
    return "unsupported";
  }
  setAts(db, job.id, handler.name);
  if (!rebuild) {
    // A new run replaces whatever page the live view kept for the job.
    await deps.browser.unpark?.(job.id);
    setStatus(db, job.id, "filling");
    incrementAttempts(db, job.id);
  }

  // The user is at the browser in these modes: show it and wait longer for them.
  const userPresent = mode !== "auto" && !rebuild;
  /** Fill what the app can and leave the rest to the user, never submitting (hand-finish and rebuild). */
  const hand = mode === "hand-finish" || rebuild;
  // The user is at the browser for these runs: their tab comes to the front of the window.
  const front = mode === "hand-finish" || mode === "interactive";
  // Whether to wait here for the user to solve a CAPTCHA or enter a code. With a live view, a run hands the page over
  // instead (the user deals with it in the dashboard or the Chrome window) unless the user is already at it.
  const waitsForUser = front || (!deps.browser.keepsPages && !rebuild);
  /** Set once a rebuild filled and highlighted the form: only then is its page worth parking. */
  let rebuilt = false;
  const startedAt = deps.now().toISOString();
  const step = (s: RunnerStep, extra: { maybeSent?: boolean } = {}) => setRunnerCurrent(db, { jobId: job.id, step: s, startedAt, mode, ...extra });
  /** Hand-finish: the fields left for the user, each with the bank question it answers (when it is one). */
  const forUser = new Map<string, { field: FieldSpec; questionId: number | null }>();
  const leaveToUser = (field: FieldSpec, questionId: number | null = null) => {
    if (!forUser.has(field.id)) forUser.set(field.id, { field, questionId });
  };
  /** Hand-finish: what the user typed into those fields, added to the submission's record. */
  const handAnswers: { label: string; value: unknown; source: string }[] = [];
  let session: BrowserSession | null = null;
  const fields: FieldSpec[] = [];
  const resolutions: Resolution[] = [];
  const byId = new Map<string, FieldSpec>();
  /** What the user should know about this run (e.g. an "Other" picked with no box to type the real value in). */
  const notes: string[] = [];
  const withNotes = (reason: string) => [reason, ...notes].join("; ");
  /** Every field a parked page shows (but files), with what the app filled in and the bank question it is blocked on. */
  const watchList = (): WatchField[] => {
    const last = new Map(resolutions.map(r => [r.fieldId, r]));
    return fields.filter(f => f.kind !== "file").map(field => {
      const r = last.get(field.id);
      return {
        field,
        filled: r?.status === "filled" ? r.answer : null,
        questionId: r?.status === "blocked" ? r.questionId : forUser.get(field.id)?.questionId ?? null,
      };
    });
  };
  let submitClicked = false;
  let beforeSubmit: Buffer | null = null;
  // Submitting after review sends exactly what the user reviewed; anything else goes back for review.
  // A rebuild of a job awaiting review shows the values the user is reviewing.
  const reviewed = mode === "submit-reviewed" || (rebuild && job.status === "ready-to-review") ? reviewedValues(getSnapshot(db, job.id)) : null;

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
    const reason = recordSubmission(db, job.id, { screenshots: [beforeSubmit, confirmation], fields, resolutions, handAnswers });
    const status = await end("submitted", reason ?? (notes.length ? notes.join("; ") : null), confirmation);
    notifySubmitted();
    return status;
  };

  /** The application may already have gone out: flag it for the user and never invite a blind retry. */
  const endUnknown = (detail: string, reason: string = UNKNOWN_SUBMISSION): Promise<JobStatus> => {
    try {
      resolveNeedsYouForJob(db, job.id);
      addNeedsYou(db, { jobId: job.id, kind: "other", message: `${job.company} · ${job.title}: ${reason} (${detail})` });
    } catch { /* the status below still flags it */ }
    return end("needs-you", reason);
  };

  /** Stops an auto run here once the runner was paused (the step before it finished). */
  const checkPaused = () => {
    if (mode === "auto" && getSettings(db).paused) throw new PausedStop();
  };
  const onAbort = () => { void session?.page.close().catch(() => {}); };

  try {
    step("Opening application");
    const settings = getSettings(db);
    signal?.throwIfAborted();
    try {
      session = await deps.browser.open({ front });
    } catch (err) {
      throw new SetupError(`The browser could not start: ${errorMessage(err)}`);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const { page } = session;
    let ctx: JobContext | null = null;
    /** "Please specify" boxes held back from the round they were first seen in (see the loop below). */
    const deferred = new Set<string>();

    /** The options a choice control offers (see AtsHandler.readOptions); none when they cannot be read. */
    const readOpts = (field: FieldSpec, typed?: string, search = false): Promise<string[]> =>
      (handler.readOptions ? handler.readOptions(page, field, typed, search)
        : handler.root(page).then(root => readOptionsField(root, field, typed, search))).catch((): string[] => []);

    /**
     * Searches a searchable list for a name before anything else is concluded: with the whole name, its distinctive
     * words ("Rice"), then other names the LLM knows the same entity by ("William Marsh Rice University"), stopping once
     * an option matches. Returns `start` plus every option the searches surfaced.
     */
    const searchOptions = async (field: FieldSpec, value: string, start: string[]): Promise<string[]> => {
      const seen = [...start];
      const searched = new Set<string>();
      // A degree ("B.S.") is found by its level's word ("Bachelor") as well as by its own text.
      const found = () => !!pickOption(value, seen) || !!pickDegree(value, seen);
      const searchAll = async (queries: string[]) => {
        for (const q of queries) {
          if (found()) return;
          const key = q.trim().toLowerCase();
          if (!key || searched.has(key)) continue;
          searched.add(key);
          for (const o of await readOpts(field, q, true)) if (!seen.includes(o)) seen.push(o);
        }
      };
      await searchAll([value, ...degreeQueries(value), ...distinctiveWords(value)]);
      if (!found()) {
        const variants = await nameVariants(deps.llm, value, field, ctx!).catch((err: unknown): string[] => {
          if (llmHaltReason(err)) throw err;
          return [];
        });
        await searchAll(variants);
      }
      return seen;
    };

    /**
     * Fills one answer. When a choice control offers no option matching it (or the field's options were never known),
     * reads the options the control really offers (a name's searchable list is also searched: see searchOptions), maps
     * the answer's value onto one of them (adaptAnswer: never an option outside the list) and fills that once; the
     * resolution then holds the answer actually filled. Only when nothing matches, a name (otherEligible) picks the
     * control's "Other" option and the resolution keeps the real value in `other`, for fillOthers to type in. Returns
     * why the field could not be filled, or null. API-wide LLM errors propagate.
     */
    const fillOne = async (r: Filled, field: FieldSpec): Promise<string | null> => {
      try {
        await handler.fill(page, field, r.answer);
        return null;
      } catch (err) {
        const value = r.answer.type === "option" ? r.answer.option : r.answer.type === "text" ? r.answer.text : null;
        if (value === null || !ctx || !OPTION_KINDS.has(field.kind) || (field.options?.length && !NO_OPTION.test(errorMessage(err)))) {
          return shortReason(err);
        }
        const eligible = otherEligible(field, r);
        let options = await readOpts(field, value);
        if (eligible && field.kind === "combobox") options = await searchOptions(field, value, options);
        const inProgress = degreeInProgress(getProfile(db).graduationMonth, deps.now());
        const adapted = options.length ? await adaptAnswer(deps.llm, value, { ...field, options }, ctx, { inProgress }) : null;
        const same = adapted?.type === r.answer.type && JSON.stringify(adapted) === JSON.stringify(r.answer);
        if (adapted && !same) {
          await handler.fill(page, field, adapted);
          r.answer = adapted;
          return null;
        }
        if (eligible && !same) {
          // The name is truly not listed: pick "Other" (a lazy list may only show it once "Other" is typed).
          let other = findOtherOption(options);
          if (!other && field.kind === "combobox") other = findOtherOption(await readOpts(field, "Other", true));
          if (other) {
            const answer: FieldAnswer = { type: "option", option: other };
            await handler.fill(page, field, answer);
            r.answer = answer;
            r.other = value;
            return null;
          }
        }
        return options.length ? `no option matches "${value}"` : shortReason(err);
      }
    };

    /**
     * Fills file fields first (the resume before any other file), lets the site finish handling the upload (its resume
     * parser may autofill or clear fields), then fills everything else, so a parser never overwrites typed answers.
     * Every field is attempted: one that cannot be filled is recorded as skipped and returned, and the rest still get
     * filled. Only API-wide LLM errors stop it.
     */
    const fillAll = async (filled: Filled[]): Promise<FillFailure[]> => {
      const failures: FillFailure[] = [];
      const attempt = async (r: Filled) => {
        const field = byId.get(r.fieldId)!;
        const reason = await fillOne(r, field).catch((err: unknown) => {
          if (llmHaltReason(err)) throw err;
          return shortReason(err);
        });
        if (reason === null) return;
        failures.push({ field, reason });
        const i = resolutions.indexOf(r);
        if (i >= 0) resolutions[i] = { fieldId: r.fieldId, status: "skip" };
      };
      const { files, rest } = fillOrder(byId, filled);
      if (files.length) step("Uploading resume");
      for (const r of files) {
        checkPaused();
        await attempt(r);
      }
      if (files.length) await handler.afterUpload?.(page);
      step("Filling fields");
      for (const r of rest) {
        checkPaused();
        await attempt(r);
      }
      return failures;
    };

    /**
     * Reads back every filled field still on the form (`onForm`). Values a late script (e.g. a resume parser) cleared or
     * replaced after they were typed are filled once more and read again. Returns the first field that still does not
     * hold its answer (with why, when filling it again failed): a blank optional field is allowed; a required one, or a
     * field holding some other value, is not.
     */
    const verify = async (onForm: ReadonlySet<string>): Promise<{ field: FieldSpec; reason?: string } | null> => {
      step("Checking answers");
      const mismatches = async () => {
        const out: { r: Filled; field: FieldSpec; got: Awaited<ReturnType<AtsHandler["readBack"]>> }[] = [];
        for (const r of resolutions) {
          if (r.status !== "filled" || !onForm.has(r.fieldId)) continue;
          const field = byId.get(r.fieldId)!;
          const got = await handler.readBack(page, field);
          if (!holds(field, r.answer, got)) out.push({ r, field, got });
        }
        return out;
      };
      let wrong = await mismatches();
      if (wrong.length) {
        const failed = (await fillAll(wrong.map(w => w.r))).find(f => f.field.required);
        if (failed) return failed;
        wrong = await mismatches();
      }
      const bad = wrong.find(w => w.field.required || !isEmpty(w.got));
      return bad ? { field: bad.field } : null;
    };

    /**
     * For each answer that picked "Other" because its real value is not listed, types the real value into the box the
     * form shows for it (followUpBox: a new text box right after the control, or the "specify" box already there). The
     * box is filled as "<control label> (other)" from the answer's source (or the user's override for that label), so it
     * is never asked about as a new question. With no box, "Other" stays selected (it is true: the value is not listed)
     * and the job's reason says so. Returns the fields read and a required box that could not be filled.
     */
    const fillOthers = async (filled: Filled[]): Promise<{ present: FieldSpec[]; failed: FillFailure | null }> => {
      let present = await handler.readFields(page);
      const picked = filled.filter(r => r.other && resolutions.includes(r));
      if (!picked.length) return { present, failed: null };
      const overrides = new Map(Object.entries(getOverrides(db, job.id)).map(([label, a]) => [normalizeLabel(label, ""), a]));
      let failed: FillFailure | null = null;
      let typed = false;
      for (const r of picked) {
        const control = byId.get(r.fieldId)!;
        const box = followUpBox(present, r.fieldId, id => byId.has(id));
        if (!box) {
          notes.push(`Picked Other for ${control.label} ("${r.other}" not listed)`);
          continue;
        }
        const spec: FieldSpec = { ...box, label: `${control.label} (other)`, description: box.label };
        fields.push(spec);
        byId.set(spec.id, spec);
        const override = overrides.get(normalizeLabel(spec.label, ""));
        const answer = override ?? await adaptAnswer(deps.llm, r.other!, spec, ctx!);
        if (!answer) {
          resolutions.push({ fieldId: spec.id, status: "skip" });
          if (spec.required) failed ??= { field: spec, reason: `"${r.other}" does not fit the box` };
          continue;
        }
        const res: Filled = { fieldId: spec.id, status: "filled", answer, source: override ? "override" : r.source };
        resolutions.push(res);
        const reason = await fillOne(res, spec).catch((err: unknown) => {
          if (llmHaltReason(err)) throw err;
          return shortReason(err);
        });
        typed = true;
        if (reason === null) continue;
        resolutions[resolutions.indexOf(res)] = { fieldId: spec.id, status: "skip" };
        if (spec.required) failed ??= { field: spec, reason };
      }
      // Typing into a box may reveal more questions: read the form again.
      if (typed) present = await handler.readFields(page);
      return { present, failed };
    };

    /**
     * Hand-finish: once every answer the app has is filled, highlights the fields left for the user and waits for them
     * to complete the form and click the site's own submit button (never clicked here). Meanwhile, every few seconds,
     * the values of those fields are read back (the last non-empty one per field is kept: the page may navigate away
     * on submit) and the page is checked for a confirmation. A confirmed submission is recorded like any other, and
     * each question the user answered by hand is approved in the bank with what they typed or picked. A window closed
     * (or a wait timed out) after the form may have been sent is flagged as a possibly sent application.
     */
    const awaitHandFinish = async (present: FieldSpec[]): Promise<JobStatus> => {
      const onForm = new Set(present.map(f => f.id));
      // A late script may have cleared an answer: fill it again, else leave it to the user too.
      const unfilled = await verify(onForm);
      if (unfilled) leaveToUser(unfilled.field);
      const todo = [...forUser.values()].filter(t => onForm.has(t.field.id));
      const root = await handler.root(page);
      await root.evaluate(inPage(highlightFields), todo.map(t => t.field.id)).catch(() => {});
      // Anything that may mean the form went out: a form post or a navigation of the page. Recorded in runnerCurrent
      // too, so a crash during the wait is flagged as a possibly sent application only when one was seen.
      let maybeSent = false;
      const WAIT_STEP = "Waiting for you to finish and submit";
      step(WAIT_STEP, { maybeSent: false });
      const flagSent = () => {
        if (maybeSent) return;
        maybeSent = true;
        step(WAIT_STEP, { maybeSent: true });
      };
      const onRequest = (req: Request) => {
        if (req.method() !== "GET" && ["document", "xhr", "fetch"].includes(req.resourceType())) flagSent();
      };
      const onNavigate = (frame: Frame) => { if (frame === page.mainFrame()) flagSent(); };
      page.on("request", onRequest);
      page.on("framenavigated", onNavigate);
      const captured = new Map<string, string | string[] | boolean>();
      const capture = async () => {
        const current = await handler.root(page).catch(() => null);
        if (!current) return;
        for (const t of todo) {
          if (t.field.kind === "file") continue;
          try {
            if (!(await current.locator(`[data-aa-id="${t.field.id}"]`).count())) continue;
            const got = await withTimeout(handler.readBack(page, t.field), 2_000);
            if (got !== null && !isEmpty(got)) captured.set(t.field.id, got);
          } catch { /* gone or busy: keep the last value read */ }
        }
      };
      const pollMs = deps.pollMs ?? HAND_POLL_MS;
      const deadline = Date.now() + (deps.handFinishWaitMs ?? HAND_FINISH_WAIT_MS);
      let outcome: SubmitOutcome = { kind: "pending" };
      try {
        while (!page.isClosed() && Date.now() < deadline) {
          await capture();
          if (page.isClosed()) break;
          outcome = await handler.outcome(page).catch((): SubmitOutcome => ({ kind: "pending" }));
          if (outcome.kind === "submitted" || outcome.kind === "already-applied") break;
          // A CAPTCHA, code or error message only shows once submit was clicked; the user deals with it here.
          if (outcome.kind !== "pending" && outcome.kind !== "validation-error") flagSent();
          await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        }
      } finally {
        page.off("request", onRequest);
        page.off("framenavigated", onNavigate);
      }

      if (outcome.kind === "already-applied") return await end("applied-manually", "Already applied");
      if (outcome.kind !== "submitted") {
        if (maybeSent) return await endUnknown(page.isClosed() ? "the window was closed before the page confirmed it" : "no confirmation from the page", HAND_UNCONFIRMED);
        return await end("needs-you", CLOSED_BEFORE_SUBMITTING);
      }
      for (const t of todo) {
        const got = captured.get(t.field.id);
        if (got !== undefined) handAnswers.push({ label: t.field.label, value: got, source: "you" });
      }
      const status = await endSubmitted(page);
      learnAnswers(db, job.company, todo, captured);
      return status;
    };

    const opened = await handler.open(page, job.url);
    if (!opened.ok) {
      if (rebuild) throw new Error(OPEN_FAILED[opened.reason](opened.detail)[1]);
      return await end(...OPEN_FAILED[opened.reason](opened.detail));
    }

    step("Reading the form");
    let batch = await handler.readFields(page);
    if (!batch.length) {
      if (rebuild) throw new Error("No form fields found");
      return await end("failed", "No form fields found");
    }
    ctx = await jobContext(job, handler, page);
    let present = batch;

    for (let round = 0; ; round++) {
      // A box that looks like the "please specify" box of the choice right before it is held back one round: an "Other"
      // picked for that choice claims it (fillOthers). Seen again unclaimed, it is resolved as usual when required and
      // left blank when optional (its choice got a listed answer).
      const held = round < MAX_EXTRA_ROUNDS
        ? batch.filter(f => !deferred.has(f.id) && looksLikeFollowUp(present, present.indexOf(f))) : [];
      for (const f of held) deferred.add(f.id);
      const blankBoxes = batch.filter(f => deferred.has(f.id) && !held.includes(f) && !f.required);
      const toResolve = batch.filter(f => !held.includes(f) && !blankBoxes.includes(f));
      for (const f of [...toResolve, ...blankBoxes]) { fields.push(f); byId.set(f.id, f); }
      step("Working out answers");
      const res: Resolution[] = [
        ...await resolveFields({ db, llm: deps.llm }, toResolve, ctx!, reviewed?.preset),
        ...blankBoxes.map((f): Resolution => ({ fieldId: f.id, status: "skip" })),
      ];
      resolutions.push(...res);

      if (hand) {
        // Everything the app has an answer for is filled; the rest is the user's (never typed into, never failed).
        for (const r of res) {
          const f = byId.get(r.fieldId)!;
          if (r.status === "blocked") {
            addBlocker(db, job.id, r.questionId, r.reason, f);
            leaveToUser(f, r.questionId);
          } else if (r.status === "needs-file" || (r.status === "skip" && f.required)) leaveToUser(f);
        }
        const answered = res.filter((r): r is Filled => r.status === "filled");
        for (const failure of await fillAll(answered)) if (failure.field.required) leaveToUser(failure.field);
        const after = await fillOthers(answered);
        if (after.failed) leaveToUser(after.failed.field);
        present = after.present;
        batch = present.filter(f => !byId.has(f.id));
        if (!batch.length || round === MAX_EXTRA_ROUNDS) break;
        continue;
      }

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
        for (const b of blocked) addBlocker(db, job.id, b.questionId, b.reason, byId.get(b.fieldId));
        resolveNeedsYouForJob(db, job.id); // this run supersedes any earlier CAPTCHA or code request
        // Still fill (and check) every field that has an answer, so the form and its screenshot show all but the questions
        // that need the user. Best effort: a field that can't be filled is left blank, the questions are what this run
        // reports, and nothing is submitted.
        try {
          const answered = res.filter((r): r is Filled => r.status === "filled");
          await fillAll(answered);
          const after = await fillOthers(answered);
          await verify(new Set(after.present.map(f => f.id)));
        } catch { /* the needs-you status below still stands */ }
        const n = new Set(blocked.map(b => b.questionId)).size;
        return await end("needs-you", n === 1 ? "1 question needs you" : `${n} questions need you`);
      }
      const unanswered = res.find(r => r.status === "skip" && byId.get(r.fieldId)?.required);
      if (unanswered) return await end("failed", `Required field "${byId.get(unanswered.fieldId)!.label}" has no answer`);

      // Every field is attempted; then a required field that could not be filled fails the job (optional ones stay blank).
      const answered = res.filter((r): r is Filled => r.status === "filled");
      const failed = (await fillAll(answered)).find(f => f.field.required);
      if (failed) return await end("failed", couldNotFill(failed));

      // Answers can reveal follow-up questions; read the form again (typing any "Other" value into its box) and handle
      // any new ones.
      const after = await fillOthers(answered);
      if (after.failed) return await end("failed", couldNotFill(after.failed));
      present = after.present;
      batch = present.filter(f => !byId.has(f.id));
      if (!batch.length) break;
      if (round === MAX_EXTRA_ROUNDS) {
        const extra = batch.find(f => f.required);
        if (extra) return await end("failed", `New required questions kept appearing (last: "${extra.label}")`);
        break;
      }
    }

    if (rebuild) {
      // Everything the app knows is filled: outline what is left and hand the page to the live view (see finally).
      const onForm = new Set(present.map(f => f.id));
      const unfilled = await verify(onForm);
      if (unfilled) leaveToUser(unfilled.field);
      const todo = [...forUser.values()].filter(t => onForm.has(t.field.id)).map(t => t.field.id);
      await (await handler.root(page)).evaluate(inPage(highlightFields), todo).catch(() => {});
      rebuilt = true;
      return job.status;
    }
    if (hand) return await awaitHandFinish(present);

    // Verify the fields still on the form (a conditional question may have been removed again).
    const unfilled = await verify(new Set(present.map(f => f.id)));
    if (unfilled) return await end("failed", couldNotFill(unfilled));

    step("Waiting for review gate");
    if (reviewed) {
      const unseen = resolutions.some(r => r.status === "filled" && r.source !== "override" && !reviewed.includes(byId.get(r.fieldId)!, r.answer));
      if (unseen) return await end("ready-to-review", withNotes("Form changed since review"));
    } else if (reviewApplies(settings, job.company)) return await end("ready-to-review", withNotes("Waiting for your review"));

    if (dailyLimitReached(db, settings, deps.now())) {
      setStatus(db, job.id, "queued", "Daily limit reached");
      return "queued";
    }

    checkPaused();
    beforeSubmit = await screenshot(page);
    step("Submitting");
    submitClicked = true;
    await handler.submit(page);
    step("Waiting for confirmation");
    const pollMs = deps.pollMs ?? POLL_MS;
    let outcome = await pollOutcome(handler, page, deps.submitWaitMs ?? SUBMIT_WAIT_MS, pollMs, o => o.kind === "pending");

    if (outcome.kind === "captcha" || outcome.kind === "verification-code") {
      const human = HUMAN[outcome.kind];
      await deps.notify("AI Applier needs you", `${job.company}: ${human.ask} in the browser window`);
      resolveNeedsYouForJob(db, job.id);
      addNeedsYou(db, { jobId: job.id, kind: human.kind, message: `${job.company} · ${job.title}: ${human.ask}` });
      // Nobody is at the tab: hand it to the user right away (the live view and the Chrome window show it).
      if (!waitsForUser) return await end("needs-you", human.reason);
      const humanWait = deps.humanWaitMs ?? HUMAN_WAIT_MS;
      step("Waiting for you (CAPTCHA/code)");
      outcome = await pollOutcome(handler, page, userPresent ? Math.max(humanWait, INTERACTIVE_WAIT_MS) : humanWait, pollMs,
        o => o.kind === "pending" || isHuman(o));
      // The user may have solved it and sent the form without the page confirming: never invite a blind retry.
      if (page.isClosed()) return await endUnknown(`The browser window was closed during the ${human.reason.toLowerCase()} wait`);
      if (isHuman(outcome)) return await end("needs-you", human.reason);
      if (outcome.kind === "pending") return await endUnknown(`No confirmation after the ${human.reason.toLowerCase()} wait`);
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
    // A rebuild leaves the job as it was: whoever asked for it shows why it failed.
    if (rebuild) throw err;
    if (err instanceof PausedStop) {
      // Not a failed attempt: the job waits, filled so far, until the runner is resumed (which queues it again).
      decrementAttempts(db, job.id);
      try {
        resolveNeedsYouForJob(db, job.id);
        addNeedsYou(db, { jobId: job.id, kind: "other", message: `${job.company} · ${job.title}: ${PAUSED_MID_RUN}` });
      } catch { /* the status below still says it */ }
      return await end("needs-you", PAUSED_MID_RUN);
    }
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
    signal?.removeEventListener("abort", onAbort);
    // A job left waiting on the user keeps its page open for the dashboard's live view (when the browser can keep it).
    let kept = false;
    const now = getJob(db, job.id);
    if (session?.park && !signal?.aborted && !session.page.isClosed() && now && canOpenLive(now) && (!rebuild || rebuilt)) {
      try {
        kept = session.park(job.id, { handler, fields: [...fields], resolutions: [...resolutions], watch: watchList(), notes: [...notes] });
      } catch { kept = false; }
    }
    if (!kept) await session?.close().catch(() => {});
    if (getRunnerCurrent(db)?.jobId === job.id) clearRunnerCurrent(db);
  }
}

/**
 * Writes the record of a confirmed submission (screenshots in order, every answer filled plus `handAnswers`) and the
 * documents it used. Returns the job's reason when the record could not be written, else null; never throws.
 */
function recordSubmission(db: Db, jobId: string, s: {
  screenshots: (Buffer | null)[]; fields: FieldSpec[]; resolutions: Resolution[]; handAnswers: { label: string; value: unknown; source: string }[];
}): string | null {
  const byId = new Map(s.fields.map(f => [f.id, f]));
  const typed = new Set(s.handAnswers.map(a => a.label));
  let reason: string | null = null;
  try {
    saveRecord(jobId, {
      screenshots: s.screenshots.filter((x): x is Buffer => x !== null),
      answers: [
        ...s.resolutions.filter((r): r is Filled => r.status === "filled" && byId.has(r.fieldId) && !typed.has(byId.get(r.fieldId)!.label))
          .map(r => ({ label: byId.get(r.fieldId)!.label, value: answerValue(r.answer), source: r.source as string })),
        ...s.handAnswers,
      ],
      outcome: "submitted",
    });
  } catch (err) {
    reason = `Submitted, but the record could not be saved: ${errorMessage(err)}`;
  }
  try {
    const docs = usedDocuments(s.fields, s.resolutions);
    setUsedDocuments(db, jobId, docs.resume, docs.coverLetter);
  } catch { /* the tracker columns are a convenience */ }
  return reason;
}

/**
 * Approves in the bank each question the user answered by hand, with what they typed or picked (`captured`, by field
 * id). Only call it once the application went out: only answers sent with a confirmed application are worth keeping.
 */
function learnAnswers(db: Db, company: string, todo: { field: FieldSpec; questionId: number | null }[], captured: ReadonlyMap<string, string | string[] | boolean>): void {
  const saved = new Set<number>();
  for (const t of todo) {
    const got = captured.get(t.field.id);
    const text = got === undefined ? null : bankText(got);
    if (t.questionId === null || saved.has(t.questionId) || !text) continue;
    try {
      const q = getQuestion(db, t.questionId);
      if (!q) continue;
      answerQuestion(db, q.id, q.kind === "template" ? withCompanyPlaceholder(text, company) : text);
      saved.add(q.id);
    } catch { /* the submission stands */ }
  }
}

/**
 * Records a submission the user made on a parked page in the live view (the page confirmed it): the record with the
 * answers the app filled and what the user typed (`captured`, by field id), the used documents, a snapshot, the
 * submitted status (resolving the job's needs-you items), then the tracker hook, and finally the bank approvals of the
 * questions the user answered (see learnAnswers).
 */
export async function recordLiveSubmission(ctx: { db: Db; onSubmitted?(jobId: string): void }, jobId: string,
  parked: { page: Page; fields: FieldSpec[]; resolutions: Resolution[]; watch: WatchField[]; notes: string[] },
  captured: ReadonlyMap<string, string | string[] | boolean>): Promise<JobStatus> {
  const { db } = ctx;
  const job = getJob(db, jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);
  const confirmation = await screenshot(parked.page);
  const handAnswers = parked.watch.filter(w => captured.has(w.field.id))
    .map(w => ({ label: w.field.label, value: captured.get(w.field.id), source: "you" }));
  const reason = recordSubmission(db, jobId, { screenshots: [confirmation], fields: parked.fields, resolutions: parked.resolutions, handAnswers });
  try { saveSnapshot(db, jobId, { fields: parked.fields, resolutions: parked.resolutions, screenshot: confirmation }); } catch { /* a convenience */ }
  try { resolveNeedsYouForJob(db, jobId); } catch { /* the status below still stands */ }
  setStatus(db, jobId, "submitted", reason ?? (parked.notes.length ? parked.notes.join("; ") : null));
  try { ctx.onSubmitted?.(jobId); } catch { /* the tracker must never affect a job */ }
  learnAnswers(db, job.company, parked.watch, captured);
  return "submitted";
}

/** Runs inside the page: outlines the controls left for the user and scrolls the first one into view. */
function highlightFields(ids: string[]): void {
  let first: Element | null = null;
  for (const id of ids) {
    for (const el of Array.from(document.querySelectorAll(`[data-aa-id="${CSS.escape(id)}"]`))) {
      const box = el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox") ? el.closest("label") ?? el : el;
      for (const target of new Set([el, box])) {
        const s = (target as HTMLElement).style;
        s.setProperty("outline", "3px solid #e7a33e", "important");
        s.setProperty("outline-offset", "2px", "important");
      }
      if (!first) first = box;
    }
  }
  first?.scrollIntoView({ block: "center" });
}

/** Resolves to the promise's value, or rejects after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); })])
    .finally(() => clearTimeout(timer));
}

/** The bank answer for a value read off a field: the text typed, the option picked, or the options ticked. */
function bankText(got: string | string[] | boolean): string | null {
  if (typeof got === "boolean") return got ? "Yes" : null;
  const text = (Array.isArray(got) ? got.join(", ") : got).trim();
  return text || null;
}

/** Steps at or after clicking submit: the application may have gone out. */
const MAYBE_SENT_STEPS: ReadonlySet<string> = new Set<RunnerStep>(["Submitting", "Waiting for confirmation", "Waiting for you (CAPTCHA/code)"]);
const HAND_WAIT_STEP: RunnerStep = "Waiting for you to finish and submit";

/** The queued reason of a job whose run was cut off before anything could have been sent. */
export const INTERRUPTED_REQUEUED = "Interrupted before submitting — queued again";

/**
 * Whether a run of `jobId` cut off at `current` (the runner's last recorded step) certainly never sent the application:
 * it stopped while opening, reading, answering, uploading, filling, checking or at the review gate, or while waiting for
 * the user to finish a hand-finish run with nothing on the page suggesting the form went out. False (possibly sent) when
 * the record is missing, is for another job, names an unknown step, or the run had reached submitting.
 */
export function interruptedBeforeSending(current: RunnerCurrent | null, jobId: string): boolean {
  if (!current || current.jobId !== jobId || !(STEPS as readonly string[]).includes(current.step)) return false;
  if (MAYBE_SENT_STEPS.has(current.step)) return false;
  if (current.step === HAND_WAIT_STEP) return current.mode === "hand-finish" && current.maybeSent === false;
  return true;
}

/**
 * A job left "filling" means the app stopped mid-run (Ctrl-C, crash). The runner's last recorded step (kv
 * runnerCurrent) tells how far it got: a run cut off before anything could have been sent is queued again (its attempt
 * not counted, no needs-you item); any other — submit possibly clicked, or no usable record — is flagged as state
 * unknown, so only the confirmed Retry on its page runs it again. Call at startup, before any run and before the record
 * is cleared.
 */
export function flagInterruptedRuns(db: Db): { flagged: string[]; requeued: string[] } {
  const rows = db.prepare("SELECT id, company, title FROM jobs WHERE status = 'filling' ORDER BY rowid").all() as unknown as { id: string; company: string; title: string }[];
  const current = getRunnerCurrent(db);
  const flagged: string[] = [];
  const requeued: string[] = [];
  for (const j of rows) {
    resolveNeedsYouForJob(db, j.id);
    if (interruptedBeforeSending(current, j.id)) {
      setStatus(db, j.id, "queued", INTERRUPTED_REQUEUED);
      decrementAttempts(db, j.id);
      requeued.push(j.id);
      continue;
    }
    const at = current?.jobId === j.id ? `, at "${current.step}"` : "";
    addNeedsYou(db, { jobId: j.id, kind: "other", message: `${j.company} · ${j.title}: ${UNKNOWN_SUBMISSION} (the app stopped during this application${at})` });
    setStatus(db, j.id, "needs-you", UNKNOWN_SUBMISSION);
    flagged.push(j.id);
  }
  return { flagged, requeued };
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
  const byLabel = new Map<string, ({ answer: FieldAnswer; source: FillSource } & Extra)[]>();
  const labels = new Map((snap?.fields ?? []).map(f => [f.id, f.label]));
  for (const r of snap?.resolutions ?? []) {
    const label = labels.get(r.fieldId);
    if (r.status !== "filled" || label === undefined) continue;
    const key = normalizeLabel(label, "");
    const extra: Extra = { ...(r.entity ? { entity: true } : {}), ...(r.other ? { other: r.other } : {}) };
    byLabel.set(key, [...(byLabel.get(key) ?? []), { answer: r.answer, source: r.source, ...extra }]);
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

export function isEmpty(got: string | string[] | boolean | null): boolean {
  return got === null || got === false || (typeof got === "string" && got.trim() === "") || (Array.isArray(got) && got.length === 0);
}

/**
 * Whether the value read back from the page is the answer that was filled. Text inputs must hold the
 * same text (phone numbers compared without formatting); choices only need some selection, since a
 * widget may show a different label for the chosen option (e.g. a dial code for a phone country).
 */
export function holds(field: FieldSpec, answer: FieldAnswer, got: string | string[] | boolean | null): boolean {
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

/**
 * The order to fill answers in: file uploads first (the resume before any other file), then every other field in form
 * order. A site's resume parser runs on upload and may overwrite fields, so nothing is typed before it has run.
 */
export function fillOrder<R extends Filled>(byId: ReadonlyMap<string, FieldSpec>, filled: R[]): { files: R[]; rest: R[] } {
  const isFile = (r: R) => r.answer.type === "file" || byId.get(r.fieldId)?.kind === "file";
  const files = filled.filter(isFile);
  return {
    files: [...files.filter(r => r.source === "resume"), ...files.filter(r => r.source !== "resume")],
    rest: filled.filter(r => !isFile(r)),
  };
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
