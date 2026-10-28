import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { answerQuestion } from "../answers/inbox.js";
import { getQuestion, listQuestions, approveAnswer, deleteQuestion, resolveNeedsYouForJob, setDraft, setOverride } from "../answers/bank.js";
import { reviseDraft } from "../answers/draft.js";
import type { Db } from "../db/db.js";
import type { Llm } from "../llm/llm.js";
import { normalizeLabel } from "../answers/classify.js";
import { getJob, setStatus } from "../jobs/repo.js";
import { paths } from "../paths.js";
import { getProfile, saveProfile, type Profile } from "../profile/profile.js";
import { importResume } from "../profile/resume.js";
import { saveFilters } from "../filters/filters.js";
import { addSource, listSources, setSourceEnabled } from "../sources/repo.js";
import { getSecret, setSecret } from "../secrets.js";
import { saveSettings, type Settings } from "../settings.js";
import {
  ApplicationsPage, JobDetailPage, canMarkApplied, canRetry, canSkip, fieldViews, isStatus, isUnknownSubmission, parseAnswer,
} from "./pages/applications.js";
import { BankPage } from "./pages/bank.js";
import { PROFILE_FIELDS, ProfilePage } from "./pages/profile.js";
import { SettingsPage } from "./pages/settings.js";
import { PreviewFragment, SourcesPage, parseFilterForm, previewCount } from "./pages/sources.js";
import { CardFragment, InboxPage, OpeningBrowser, SavedNotice } from "./pages/inbox.js";

export interface AppContext {
  db: Db;
  llm: Llm;
  runInteractive(jobId: string): void;
  /** Submits a job that is ready to review (runs in the background). */
  runReviewed(jobId: string): void;
  pollNow(): void;
  /** Keychain access; defaults to the real macOS Keychain. Tests inject fakes. */
  secrets?: { get(name: string): Promise<string | null>; set(name: string, value: string): Promise<void> };
}

const API_KEY_NAME = "anthropic-api-key";
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** Turns a GitHub repo URL or a listings.json URL into a source, or null if it is neither. */
export function sourceFromUrl(input: string): { id: string; kind: "simplify-json" | "readme-table"; url: string } | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (u.pathname.endsWith("listings.json")) return { id: slug(u.host + u.pathname), kind: "simplify-json", url: u.toString() };
  if (u.host === "github.com") {
    const [owner, repoRaw] = u.pathname.split("/").filter(Boolean);
    const repo = repoRaw?.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return { id: slug(`${owner}-${repo}`), kind: "readme-table", url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md` };
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const toBool = (v: string): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const { db } = ctx;
  const secrets = ctx.secrets ?? { get: getSecret, set: setSecret };
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
    const value = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : typeof raw === "string" ? raw : "";
    const view = fieldViews(db, job).views.find(v => v.field.label === label);
    if (!view) return c.text("Unknown field", 400);
    // A single ticked box arrives as a plain string; keep multi-choice values as an array end to end.
    const multi = view.field.kind === "checkbox-group" || view.answer?.type === "options";
    const input = multi ? (Array.isArray(value) ? value : value ? [value] : []) : Array.isArray(value) ? value.join(", ") : value;
    if (view.field.kind === "file" || view.answer?.type === "file") return c.text("File fields can't be edited here", 400);
    let answer = parseAnswer(view.field, view.answer, input);
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
    if (form.saveToBank && view.source === "bank" && answer.type !== "text") notice = "?notice=bank-miss";
    else if (form.saveToBank && view.source === "bank") {
      const key = normalizeLabel(label, job.company);
      const matches = listQuestions(db).filter(x => [x.canonical, ...x.variants].some(t => normalizeLabel(t, job.company) === key));
      if (matches.length === 1) approveAnswer(db, matches[0]!.id, (answer as { text: string }).text);
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

  app.get("/bank", c => c.html(BankPage({ db, search: c.req.query("search")?.trim() })));

  app.post("/bank/:id", async c => {
    const id = Number(c.req.param("id"));
    if (!getQuestion(db, id)) return c.text("Unknown question", 404);
    const form = await c.req.parseBody();
    const answer = str(form.answer);
    if (!answer) return c.text("Type an answer first.", 400);
    approveAnswer(db, id, answer, form.kind === "template" || form.kind === "global" ? form.kind : undefined);
    return c.redirect("/bank", 303);
  });

  app.post("/bank/:id/delete", c => {
    deleteQuestion(db, Number(c.req.param("id")));
    return c.redirect("/bank", 303);
  });

  app.get("/profile", c => c.html(ProfilePage({ db })));

  app.post("/profile", async c => {
    const form = await c.req.parseBody();
    const patch: Record<string, unknown> = {};
    for (const f of PROFILE_FIELDS) {
      if (!(f.key in form)) continue;
      const v = str(form[f.key]);
      patch[f.key] = f.kind === "bool" ? toBool(v) : f.kind === "list" ? v.split(",").map(s => s.trim()).filter(Boolean) : v || null;
    }
    saveProfile(db, patch as Partial<Profile>);
    return c.redirect("/profile", 303);
  });

  app.post("/profile/resume", async c => {
    const file = (await c.req.parseBody()).resume;
    if (!(file instanceof File) || file.type !== "application/pdf") return c.html(ProfilePage({ db, error: "Upload a PDF file." }));
    if (file.size > MAX_RESUME_BYTES) return c.html(ProfilePage({ db, error: "That file is over 10 MB." }));
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return c.html(ProfilePage({ db, error: "That file is not a valid PDF." }));
    const dir = mkdtempSync(path.join(tmpdir(), "ai-applier-resume-"));
    try {
      const tmp = path.join(dir, "resume.pdf");
      writeFileSync(tmp, bytes);
      const before = getProfile(db);
      const after = await importResume(db, ctx.llm, tmp);
      const filled = (Object.keys(after) as (keyof Profile)[])
        .filter(k => k !== "resumePath" && k !== "resumeText" && JSON.stringify(before[k]) !== JSON.stringify(after[k])).length;
      return c.html(ProfilePage({ db, notice: `Filled ${filled} ${filled === 1 ? "field" : "fields"} from your resume` }));
    } catch (e) {
      return c.html(ProfilePage({ db, error: `Couldn't read the resume: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  app.get("/sources", c => c.html(SourcesPage({ db })));

  app.post("/sources", async c => {
    const form = await c.req.parseBody();
    const src = sourceFromUrl(str(form.url));
    if (!src) return c.html(SourcesPage({ db, error: "Enter a GitHub repo URL or a link to a listings.json file." }), 400);
    if (listSources(db).some(s => s.id === src.id || s.url === src.url)) return c.html(SourcesPage({ db, error: "That source is already added." }), 400);
    addSource(db, { ...src, enabled: true });
    return c.redirect("/sources", 303);
  });

  app.post("/sources/poll", c => {
    ctx.pollNow();
    return c.redirect("/sources", 303);
  });

  app.post("/sources/:id/toggle", async c => {
    const id = c.req.param("id");
    if (!listSources(db).some(s => s.id === id)) return c.text("Unknown source", 404);
    setSourceEnabled(db, id, str((await c.req.parseBody()).enabled) === "1");
    return c.redirect("/sources", 303);
  });

  app.get("/filters/preview", c => c.html(PreviewFragment(previewCount(db, parseFilterForm(c.req.query()), new Date()))));

  app.post("/filters", async c => {
    saveFilters(db, parseFilterForm(await c.req.parseBody()));
    return c.redirect("/sources", 303);
  });

  app.get("/settings", async c => c.html(SettingsPage({ db, keySet: !!(await secrets.get(API_KEY_NAME)) })));

  app.post("/settings", async c => {
    const form = await c.req.parseBody();
    const mode = str(form.reviewMode);
    if (mode !== "off" && mode !== "all" && mode !== "companies") return c.text("Invalid review mode", 400);
    const poll = Number(str(form.pollMinutes));
    if (!Number.isInteger(poll) || poll < 1) return c.text("Poll minutes must be a whole number of at least 1", 400);
    const limitRaw = str(form.dailyLimit);
    const limit = limitRaw === "" ? null : Number(limitRaw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) return c.text("Daily limit must be a whole number of at least 1", 400);
    const patch: Partial<Settings> = {
      reviewMode: mode, dailyLimit: limit, pollMinutes: poll, headless: !!str(form.headless), paused: !!str(form.paused),
      reviewCompanies: str(form.reviewCompanies).split(",").map(s => s.trim()).filter(Boolean),
    };
    saveSettings(db, patch);
    const key = str(form.apiKey);
    if (key) await secrets.set(API_KEY_NAME, key);
    return c.redirect("/settings", 303);
  });

  return app;
}
