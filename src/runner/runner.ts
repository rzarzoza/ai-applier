import path from "node:path";
import type { Page } from "playwright";
import { addBlocker, addNeedsYou, clearBlockersForJob, getOverrides, resolveNeedsYouForJob } from "../answers/bank.js";
import { adaptAnswer, nameVariants, pickOption } from "../answers/adapt.js";
import { normalizeLabel } from "../answers/classify.js";
import { distinctiveWords, findOtherOption, followUpBox, isOtherOption, looksLikeFollowUp, otherEligible } from "../answers/other.js";
import { resolveFields, type Extra, type FillSource, type Preset, type Resolution } from "../answers/resolve.js";
import { atsNameFromUrl, detectAts, HANDLERS } from "../ats/registry.js";
import type { AtsHandler, OpenResult, SubmitOutcome } from "../ats/types.js";
import type { Db } from "../db/db.js";
import { readOptions as readOptionsField } from "../forms/fill.js";
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
  /** What the user should know about this run (e.g. an "Other" picked with no box to type the real value in). */
  const notes: string[] = [];
  const withNotes = (reason: string) => [reason, ...notes].join("; ");
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
    const status = await end("submitted", reason ?? (notes.length ? notes.join("; ") : null), confirmation);
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
      const searchAll = async (queries: string[]) => {
        for (const q of queries) {
          if (pickOption(value, seen)) return;
          const key = q.trim().toLowerCase();
          if (!key || searched.has(key)) continue;
          searched.add(key);
          for (const o of await readOpts(field, q, true)) if (!seen.includes(o)) seen.push(o);
        }
      };
      await searchAll([value, ...distinctiveWords(value)]);
      if (!pickOption(value, seen)) {
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
        const adapted = options.length ? await adaptAnswer(deps.llm, value, { ...field, options }, ctx) : null;
        const same = adapted?.type === r.answer.type && JSON.stringify(adapted) === JSON.stringify(r.answer);
        if (adapted && !same) {
          await handler.fill(page, field, adapted);
          r.answer = adapted;
          if (eligible && adapted.type === "option" && isOtherOption(adapted.option)) r.other = value;
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
      for (const r of files) await attempt(r);
      if (files.length) await handler.afterUpload?.(page);
      for (const r of rest) await attempt(r);
      return failures;
    };

    /**
     * Reads back every filled field still on the form (`onForm`). Values a late script (e.g. a resume parser) cleared or
     * replaced after they were typed are filled once more and read again. Returns the first field that still does not
     * hold its answer (with why, when filling it again failed): a blank optional field is allowed; a required one, or a
     * field holding some other value, is not.
     */
    const verify = async (onForm: ReadonlySet<string>): Promise<{ field: FieldSpec; reason?: string } | null> => {
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

    const opened = await handler.open(page, job.url);
    if (!opened.ok) return await end(...OPEN_FAILED[opened.reason](opened.detail));

    let batch = await handler.readFields(page);
    if (!batch.length) return await end("failed", "No form fields found");
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
      const res: Resolution[] = [
        ...await resolveFields({ db, llm: deps.llm }, toResolve, ctx!, reviewed?.preset),
        ...blankBoxes.map((f): Resolution => ({ fieldId: f.id, status: "skip" })),
      ];
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

    // Verify the fields still on the form (a conditional question may have been removed again).
    const unfilled = await verify(new Set(present.map(f => f.id)));
    if (unfilled) return await end("failed", couldNotFill(unfilled));

    if (reviewed) {
      const unseen = resolutions.some(r => r.status === "filled" && r.source !== "override" && !reviewed.includes(byId.get(r.fieldId)!, r.answer));
      if (unseen) return await end("ready-to-review", withNotes("Form changed since review"));
    } else if (reviewApplies(settings, job.company)) return await end("ready-to-review", withNotes("Waiting for your review"));

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
