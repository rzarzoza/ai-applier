import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { answerQuestion } from "../answers/inbox.js";
import { getQuestion, listQuestions, approveAnswer, resolveNeedsYouForJob, setDraft, setOverride } from "../answers/bank.js";
import { reviseDraft } from "../answers/draft.js";
import type { Db } from "../db/db.js";
import type { Llm } from "../llm/llm.js";
import { normalizeLabel } from "../answers/classify.js";
import { getJob, setStatus } from "../jobs/repo.js";
import { paths } from "../paths.js";
import { getProfile } from "../profile/profile.js";
import {
  ApplicationsPage, JobDetailPage, canMarkApplied, canRetry, canSkip, fieldViews, isStatus, isUnknownSubmission, parseAnswer,
} from "./pages/applications.js";
import { CardFragment, InboxPage, OpeningBrowser, SavedNotice } from "./pages/inbox.js";

export interface AppContext {
  db: Db;
  llm: Llm;
  runInteractive(jobId: string): void;
  /** Submits a job that is ready to review (runs in the background). */
  runReviewed(jobId: string): void;
  pollNow(): void;
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const { db } = ctx;
  const card = (id: number, error?: string) => CardFragment({ db, id, error });

  app.get("/", c => c.redirect("/inbox"));
  app.get("/inbox", c => c.html(InboxPage({ db })));

  app.post("/inbox/:id/answer", async c => {
    const id = Number(c.req.param("id"));
    if (!getQuestion(db, id)) return c.text("Unknown question", 404);
    const form = await c.req.parseBody();
    const text = typeof form.text === "string" ? form.text.trim() : "";
    if (!text) return c.html(card(id, "Type an answer first."));
    const kind = form.kind === "template" || form.kind === "global" ? form.kind : form.kindChoice ? "global" : undefined;
    const { requeued } = answerQuestion(db, id, text, kind);
    return c.html(SavedNotice({ requeued: requeued.length }));
  });

  app.post("/inbox/:id/use-draft", c => {
    const id = Number(c.req.param("id"));
    const q = getQuestion(db, id);
    if (!q) return c.text("Unknown question", 404);
    if (!q.draft) return c.html(card(id, "There is no draft to use."));
    const { requeued } = answerQuestion(db, id, q.draft);
    return c.html(SavedNotice({ requeued: requeued.length }));
  });

  app.post("/inbox/:id/revise", async c => {
    const id = Number(c.req.param("id"));
    const q = getQuestion(db, id);
    if (!q) return c.text("Unknown question", 404);
    const form = await c.req.parseBody();
    const instruction = typeof form.instruction === "string" ? form.instruction.trim() : "";
    if (!q.draft || !instruction) return c.html(card(id, "Tell the AI what to change."));
    try {
      setDraft(db, id, await reviseDraft(ctx.llm, getProfile(db), q.canonical, q.draft, instruction));
    } catch (e) {
      return c.html(card(id, `Couldn't revise the draft: ${e instanceof Error ? e.message : String(e)}`));
    }
    return c.html(card(id));
  });

  app.post("/needs-you/:jobId/do-it-now", c => {
    ctx.runInteractive(c.req.param("jobId"));
    return c.html(OpeningBrowser());
  });

  const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json" };

  app.get("/records/*", c => {
    const rel = c.req.path.slice("/records/".length);
    try {
      const root = realpathSync(paths.records);
      const file = realpathSync(path.resolve(root, decodeURIComponent(rel)));
      if (!file.startsWith(root + path.sep) || !statSync(file).isFile()) return c.text("Not found", 404);
      return c.body(readFileSync(file), 200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
    } catch {
      return c.text("Not found", 404);
    }
  });

  app.get("/applications", c => {
    const status = c.req.query("status");
    return c.html(ApplicationsPage({ db, status: isStatus(status) ? status : undefined, page: Number(c.req.query("page")) || 1 }));
  });

  app.get("/applications/:id", c => {
    const job = getJob(db, c.req.param("id"));
    return job ? c.html(JobDetailPage({ db, job, notice: c.req.query("notice") })) : c.text("Unknown job", 404);
  });

  app.post("/applications/:id/field", async c => {
    const job = getJob(db, c.req.param("id"));
    if (!job) return c.text("Unknown job", 404);
    if (job.status !== "ready-to-review") return c.text("Only jobs ready to review can be edited", 409);
    const form = await c.req.parseBody({ all: true });
    const label = typeof form.label === "string" ? form.label : "";
    const raw = form.value;
    const value = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").join(", ") : typeof raw === "string" ? raw : "";
    const view = fieldViews(db, job).views.find(v => v.field.label === label);
    if (!view) return c.text("Unknown field", 400);
    if (view.field.kind === "file" || view.answer?.type === "file") return c.text("File fields can't be edited here", 400);
    let answer = parseAnswer(view.field, view.answer, value);
    const known = view.field.options;
    if (known?.length && (answer.type === "option" || answer.type === "options")) {
      const canon = (v: string) => known.find(o => o.trim().toLowerCase() === v.trim().toLowerCase());
      const picked = answer.type === "option" ? [answer.option] : answer.options;
      const mapped = picked.map(canon);
      if (mapped.some(m => m === undefined)) return c.text("That is not one of the field's options", 400);
      answer = answer.type === "option" ? { type: "option", option: mapped[0]! } : { type: "options", options: mapped as string[] };
    }
    setOverride(db, job.id, label, answer);
    let notice = "";
    if (form.saveToBank && answer.type === "text" && view.source === "bank") {
      const key = normalizeLabel(label, job.company);
      const matches = listQuestions(db).filter(x => [x.canonical, ...x.variants].some(t => normalizeLabel(t, job.company) === key));
      if (matches.length === 1) approveAnswer(db, matches[0]!.id, answer.text);
      else notice = "?notice=bank-miss";
    }
    return c.redirect(`/applications/${job.id}${notice}`, 303);
  });

  app.post("/applications/:id/submit", c => {
    const job = getJob(db, c.req.param("id"));
    if (!job) return c.text("Unknown job", 404);
    if (job.status !== "ready-to-review") return c.text("This job is not ready to review", 409);
    ctx.runReviewed(job.id);
    return c.redirect(`/applications/${job.id}`, 303);
  });

  const transition = (name: string, allowed: (j: NonNullable<ReturnType<typeof getJob>>) => boolean, apply: (j: NonNullable<ReturnType<typeof getJob>>) => void) =>
    app.post(`/applications/:id/${name}`, async c => {
      const job = getJob(db, c.req.param("id"));
      if (!job) return c.text("Unknown job", 404);
      if (!allowed(job)) return c.text(`A ${job.status} job can't do that`, 409);
      if (name === "retry" && isUnknownSubmission(job) && (await c.req.parseBody()).confirm !== "1")
        return c.text("Confirm that you checked the application was not sent", 400);
      apply(job);
      resolveNeedsYouForJob(db, job.id);
      return c.redirect(`/applications/${job.id}`, 303);
    });
  transition("skip", canSkip, j => setStatus(db, j.id, "skipped", "Skipped by you"));
  transition("retry", canRetry, j => setStatus(db, j.id, "queued"));
  transition("mark-applied", canMarkApplied, j => setStatus(db, j.id, "applied-manually", "Marked applied by you"));

  return app;
}
