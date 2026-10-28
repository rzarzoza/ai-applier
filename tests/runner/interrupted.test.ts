import { expect, test } from "vitest";
import { addNeedsYou, listOpenNeedsYou, openNeedsYouForJob } from "../../src/answers/bank.js";
import { openDb, type Db } from "../../src/db/db.js";
import { getJob, incrementAttempts, isUnknownSubmission, setStatus, upsertPosting } from "../../src/jobs/repo.js";
import { setRunnerCurrent, type RunnerCurrent, type RunnerStep } from "../../src/runner/current.js";
import { flagInterruptedRuns, interruptedBeforeSending, INTERRUPTED_REQUEUED } from "../../src/runner/runner.js";

/** A job cut off mid-run: status filling, one attempt counted, and (optionally) the runner's last recorded step. */
function interrupted(current?: Omit<RunnerCurrent, "jobId" | "startedAt"> & { jobId?: string }): { db: Db; id: string } {
  const db = openDb(":memory:");
  const { job } = upsertPosting(db, { sourceId: "s", listingId: "1", company: "Acme", title: "Intern", locations: ["NYC"], category: null,
    terms: [], degrees: [], sponsorship: null, url: "https://acme.test/1", datePosted: new Date(), active: true });
  setStatus(db, job.id, "filling");
  incrementAttempts(db, job.id);
  if (current) setRunnerCurrent(db, { jobId: job.id, startedAt: new Date().toISOString(), ...current });
  return { db, id: job.id };
}

const PRE_SUBMIT: RunnerStep[] = [
  "Opening application", "Reading the form", "Working out answers", "Uploading resume", "Filling fields", "Checking answers", "Waiting for review gate",
];

test.each(PRE_SUBMIT)("a run cut off at %s is queued again, its attempt uncounted, with no needs-you item", step => {
  const { db, id } = interrupted({ step, mode: "auto" });
  expect(flagInterruptedRuns(db)).toEqual({ flagged: [], requeued: [id] });
  expect(getJob(db, id)).toMatchObject({ status: "queued", statusReason: INTERRUPTED_REQUEUED, attempts: 0 });
  expect(openNeedsYouForJob(db, id)).toEqual([]);
});

test.each(["Submitting", "Waiting for confirmation", "Waiting for you (CAPTCHA/code)"] as RunnerStep[])(
  "a run cut off at %s is flagged as possibly sent", step => {
    const { db, id } = interrupted({ step, mode: "interactive" });
    expect(flagInterruptedRuns(db)).toEqual({ flagged: [id], requeued: [] });
    const job = getJob(db, id)!;
    expect(isUnknownSubmission(job)).toBe(true);
    expect(job.attempts).toBe(1);
    expect(listOpenNeedsYou(db).map(n => n.message)).toEqual([`Acme · Intern: Submission state unknown — check before retrying (the app stopped during this application, at "${step}")`]);
  });

test("a hand-finish run waiting for the user is queued again only when nothing suggested the form went out", () => {
  const quiet = interrupted({ step: "Waiting for you to finish and submit", mode: "hand-finish", maybeSent: false });
  addNeedsYou(quiet.db, { jobId: quiet.id, kind: "other", message: "questions need you" });
  expect(flagInterruptedRuns(quiet.db)).toEqual({ flagged: [], requeued: [quiet.id] });
  expect(getJob(quiet.db, quiet.id)!.status).toBe("queued");
  expect(openNeedsYouForJob(quiet.db, quiet.id)).toEqual([]);

  const sent = interrupted({ step: "Waiting for you to finish and submit", mode: "hand-finish", maybeSent: true });
  expect(flagInterruptedRuns(sent.db)).toEqual({ flagged: [sent.id], requeued: [] });
  expect(isUnknownSubmission(getJob(sent.db, sent.id)!)).toBe(true);

  // A wait recorded without the signal (an older record) is treated as possibly sent.
  const unknown = interrupted({ step: "Waiting for you to finish and submit", mode: "hand-finish" });
  expect(flagInterruptedRuns(unknown.db).flagged).toEqual([unknown.id]);

  // A hand-finish run cut off while still filling is queued again.
  const early = interrupted({ step: "Filling fields", mode: "hand-finish" });
  expect(flagInterruptedRuns(early.db).requeued).toEqual([early.id]);
});

test("with no runner record, or one for another job, the interrupted run is flagged as possibly sent", () => {
  const none = interrupted();
  expect(flagInterruptedRuns(none.db)).toEqual({ flagged: [none.id], requeued: [] });
  expect(listOpenNeedsYou(none.db).map(n => n.message)).toEqual(["Acme · Intern: Submission state unknown — check before retrying (the app stopped during this application)"]);
  expect(getJob(none.db, none.id)!.attempts).toBe(1);

  const other = interrupted({ jobId: "someone-else", step: "Reading the form", mode: "auto" });
  expect(flagInterruptedRuns(other.db)).toEqual({ flagged: [other.id], requeued: [] });
});

test("interruptedBeforeSending rejects unknown steps and mismatched jobs", () => {
  const at = (step: string, extra: Partial<RunnerCurrent> = {}) =>
    interruptedBeforeSending({ jobId: "j", step: step as RunnerStep, startedAt: "", ...extra }, "j");
  expect(at("Filling fields")).toBe(true);
  expect(at("Something new")).toBe(false);
  expect(at("Submitting")).toBe(false);
  expect(at("Waiting for you to finish and submit", { mode: "auto", maybeSent: false })).toBe(false);
  expect(interruptedBeforeSending({ jobId: "x", step: "Filling fields", startedAt: "" }, "j")).toBe(false);
  expect(interruptedBeforeSending(null, "j")).toBe(false);
});
