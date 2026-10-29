import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { adaptAnswer, nameVariants } from "../answers/adapt.js";
import { addVariant, clearBlockersForJob, createQuestion, getQuestion, listQuestions, resolveNeedsYouForJob, setOverride } from "../answers/bank.js";
import { classifyFields, normalizeLabel, withCompanyPlaceholder } from "../answers/classify.js";
import { degreeInProgress } from "../answers/degree.js";
import { answerQuestion } from "../answers/inbox.js";
import { findOtherOption, otherEligible } from "../answers/other.js";
import { resolveFields, type Resolution } from "../answers/resolve.js";
import { atsNameFromUrl } from "../ats/registry.js";
import type { Db } from "../db/db.js";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import { getJob, setAts, setStatus, setUsedDocuments } from "../jobs/repo.js";
import { roleKey } from "../jobs/role-key.js";
import type { Job } from "../jobs/types.js";
import type { Llm } from "../llm/llm.js";
import { getProfile, type Profile } from "../profile/profile.js";
import { saveRecord } from "../runner/records.js";
import { getJson, getSettings, setJson } from "../settings.js";
import { normalizeUrl } from "../sources/normalize.js";
import { findJobForPage } from "./match.js";
import {
  TOKEN_HEADER, type AdaptResponse, type ExtAnswer, type ExtHints, type ExtResolution, type LearnResponse, type LearnValue, type ResolveResponse, type StatusResponse,
  type SubmittedResponse,
} from "./protocol.js";

const TOKEN_KEY = "extToken";

/** The pairing token the extension sends with every request; made on first use. */
export function getExtToken(db: Db): string {
  const existing = getJson<string | null>(db, TOKEN_KEY, null);
  if (existing) return existing;
  return regenerateExtToken(db);
}

/** Replaces the pairing token: an extension paired with the old one stops working until it gets the new one. */
export function regenerateExtToken(db: Db): string {
  const token = randomBytes(24).toString("base64url");
  setJson(db, TOKEN_KEY, token);
  return token;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A Chrome extension's origin (its id is 32 letters a–p). */
export const isExtensionOrigin = (origin: string | undefined) => !!origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);

export interface ExtDeps {
  db: Db;
  llm: Llm;
  /** Rewrites the tracker; called after a submission is recorded. */
  syncTracker?(): Promise<unknown>;
  /** Closes the page the app's live view keeps for a job (the job moved on). */
  closeLive?(jobId: string): Promise<void>;
}

const MAX_FIELDS = 300;
const str = (max: number) => z.string().max(max);
const FieldSpecSchema = z.object({
  id: str(64), label: str(2000), kind: z.enum(["text", "textarea", "email", "tel", "url", "number", "date", "select", "combobox", "radio", "checkbox", "checkbox-group", "file"]),
  required: z.boolean(), options: z.array(str(2000)).max(1000).optional(), maxLength: z.number().optional(), description: str(4000).optional(),
});
const ResolveSchema = z.object({ url: str(4000), referrer: str(4000).optional(), title: str(1000).default(""), company: str(500).optional(), fields: z.array(FieldSpecSchema).max(MAX_FIELDS) });
const Value = z.union([str(20000), z.array(str(2000)).max(200), z.boolean()]);
const LearnSchema = z.object({
  url: str(4000), referrer: str(4000).optional(), title: str(1000).optional(), company: str(500).optional(),
  answers: z.array(z.object({
    label: str(2000), kind: FieldSpecSchema.shape.kind, options: z.array(str(2000)).max(1000).optional(), value: Value,
    source: str(40).optional(), questionId: z.number().int().optional(),
  })).max(MAX_FIELDS),
});
const AdaptSchema = z.object({
  url: str(4000), referrer: str(4000).optional(), title: str(1000).optional(), company: str(500).optional(),
  field: FieldSpecSchema, value: z.union([str(20000), z.array(str(2000)).max(200)]), options: z.array(str(2000)).max(2000),
  source: str(40).optional(), entity: z.boolean().optional(), final: z.boolean().optional(),
});
const SubmittedSchema = z.object({
  url: str(4000), referrer: str(4000).optional(), title: str(1000).default(""), company: str(500).default(""), resumeUsed: str(500).optional(), coverLetterUsed: str(500).optional(),
  answers: z.array(z.object({ label: str(2000), value: Value })).max(MAX_FIELDS).optional(),
});

/** A company name from the page's host and path when the page names none (acme from job-boards.greenhouse.io/acme/...). */
export function companyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);
    // SmartRecruiters' one-click form: /oneclick-ui/company/<Company>/publication/<uuid>.
    const first = parts[0] === "oneclick-ui" && parts[1] === "company" ? parts[2] ?? "" : parts[0] ?? "";
    const pathCompany = /greenhouse\.io$|^jobs\.lever\.co$|^jobs\.ashbyhq\.com$|^apply\.workable\.com$|^jobs\.smartrecruiters\.com$|^www\.smartr\.me$/.test(host)
      && first && first !== "embed" ? first : u.searchParams.get("for") ?? "";
    const raw = pathCompany || host.replace(/^(www|jobs|careers|boards|apply)\./, "").split(".")[0] || host;
    return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()).trim();
  } catch { return ""; }
}

function jobContext(job: Job | null, url: string, title: string, company: string | undefined): JobContext {
  if (job) return { jobId: job.id, company: job.company, title: job.title, location: job.chosenLocation ?? job.locations[0] ?? "", term: job.terms[0] ?? null };
  return { jobId: `ext:${normalizeUrl(url)}`, company: company?.trim() || companyFromUrl(url), title: title.trim(), location: "", term: null };
}

const toExt = (a: FieldAnswer): ExtAnswer => (a.type === "file" ? { type: "file", resume: true } : a);
const TEXT_KINDS = new Set<FieldSpec["kind"]>(["text", "textarea", "email", "tel", "url", "number", "date"]);

/** Turns the resolver's answers into what the extension applies; unapproved drafts become suggestions, never fills. */
async function forExtension(deps: ExtDeps, fields: FieldSpec[], resolutions: Resolution[], job: JobContext, profile: Profile): Promise<ExtResolution[]> {
  const byId = new Map(fields.map(f => [f.id, f]));
  const out: ExtResolution[] = [];
  for (const r of resolutions) {
    switch (r.status) {
      case "filled":
        out.push({
          fieldId: r.fieldId, status: "filled", answer: toExt(r.answer), source: r.source,
          ...(r.other ? { other: r.other } : {}), ...(r.entity ? { entity: true as const } : {}),
        });
        break;
      case "skip":
        out.push({ fieldId: r.fieldId, status: "skip" });
        break;
      case "needs-file":
        out.push({ fieldId: r.fieldId, status: "needs-you", reason: "file" });
        break;
      case "blocked": {
        const q = getQuestion(deps.db, r.questionId);
        const field = byId.get(r.fieldId);
        if (r.reason === "approval" && q?.draft && field) {
          let suggestion: ExtAnswer = { type: "text", text: q.draft };
          if (!TEXT_KINDS.has(field.kind)) {
            try {
              const adapted = await adaptAnswer(deps.llm, q.draft, field, job, { inProgress: degreeInProgress(profile.graduationMonth) });
              if (adapted && adapted.type !== "file") suggestion = adapted;
            } catch { /* the plain text still works as a suggestion */ }
          }
          out.push({ fieldId: r.fieldId, status: "suggestion", suggestion, text: q.draft, questionId: r.questionId });
        } else out.push({ fieldId: r.fieldId, status: "needs-you", reason: r.reason, questionId: r.questionId });
        break;
      }
    }
  }
  return out;
}

/** What the bank keeps for a value the user typed or picked (an unticked box says nothing). */
function bankText(v: LearnValue): string | null {
  if (typeof v === "boolean") return v ? "Yes" : null;
  const text = (Array.isArray(v) ? v.join(", ") : v).trim();
  return text || null;
}

function asAnswer(kind: FieldSpec["kind"], v: LearnValue): FieldAnswer | null {
  if (kind === "file") return null;
  if (kind === "checkbox") return typeof v === "boolean" ? { type: "check", checked: v } : null;
  if (kind === "checkbox-group") return { type: "options", options: Array.isArray(v) ? v : String(v).split(/\s*,\s*/).filter(Boolean) };
  const text = Array.isArray(v) ? v.join(", ") : String(v);
  if (!text.trim()) return null;
  if (kind === "select" || kind === "radio") return { type: "option", option: text };
  return { type: "text", text };
}

/** Sources whose value is the profile's or the app's records: a change the user makes there is for this job only. */
const JOB_ONLY_SOURCES = new Set(["profile", "derived", "consent", "resume", "override"]);

const cleanLabel = (label: string) => label.trim().replace(/\s*\*+$/, "").trim();

/**
 * Saves the values the user gave the extension's form: an approved bank answer (the named question, else the one whose
 * wording or variant is this label, else a new one worded by the classifier) and, when the page is a known job, a
 * per-job override.
 */
export async function learn(deps: ExtDeps, body: z.infer<typeof LearnSchema>): Promise<LearnResponse> {
  const { db, llm } = deps;
  const job = findJobForPage(db, body.url, body.referrer);
  const ctx = jobContext(job, body.url, body.title ?? "", body.company);
  let learned = 0;
  let overrides = 0;
  const pending: { field: FieldSpec; text: string; questionId?: number }[] = [];
  body.answers.forEach((a, i) => {
    if (a.kind === "file") return;
    if (job) {
      const ans = asAnswer(a.kind, a.value);
      if (ans) { setOverride(db, job.id, a.label, ans); overrides++; }
    }
    if (a.source && JOB_ONLY_SOURCES.has(a.source)) return;
    const text = bankText(a.value);
    if (!text) return;
    pending.push({ field: { id: `l${i}`, label: a.label, kind: a.kind, required: false, ...(a.options?.length ? { options: a.options } : {}) }, text, questionId: a.questionId });
  });
  if (!pending.length) return { ok: true, learned, overrides };

  const key = (label: string) => normalizeLabel(label, ctx.company);
  const byLabel = (label: string) =>
    listQuestions(db).filter(q => [q.canonical, ...q.variants].some(t => key(t) === key(label)));
  const unknown = pending.filter(p => !(p.questionId && getQuestion(db, p.questionId)) && byLabel(p.field.label).length !== 1);
  const classes = unknown.length ? await classifyFields(db, llm, unknown.map(p => p.field), ctx).catch(() => new Map()) : new Map();

  for (const p of pending) {
    let q = p.questionId ? getQuestion(db, p.questionId) : null;
    if (!q) {
      const matches = byLabel(p.field.label);
      if (matches.length === 1) q = matches[0]!;
    }
    if (!q) {
      const c = classes.get(p.field.id);
      // Opt-ins and consents are not answers to keep.
      if (c && (c.category === "optin-optional" || c.category === "consent-required" || c.category === "resume")) continue;
      const isQuestion = c?.category === "question" || c?.category === "cover-letter";
      const canonical = isQuestion && c?.canonicalQuestion ? c.canonicalQuestion : withCompanyPlaceholder(cleanLabel(p.field.label), ctx.company);
      // Against an existing wording of the same question (another form's variant was saved under it).
      q = listQuestions(db).find(x => key(x.canonical) === key(canonical)) ?? null;
      q ??= createQuestion(db, {
        canonical, kind: isQuestion && !c?.isFactual && c?.isCompanySpecific ? "template" : "global",
        isFactual: c ? c.isFactual || !isQuestion : true, options: p.field.options ?? null,
      });
    }
    addVariant(db, q.id, p.field.label);
    answerQuestion(db, q.id, q.kind === "template" ? withCompanyPlaceholder(p.text, ctx.company) : p.text);
    learned++;
  }
  return { ok: true, learned, overrides };
}

/**
 * Records an application the user sent from the extension: the matching job is marked submitted (with a record of the
 * answers), else a new row (source "extension") is added as submitted; then the tracker is synced.
 */
export function submitted(deps: ExtDeps, body: z.infer<typeof SubmittedSchema>): SubmittedResponse {
  const { db } = deps;
  const now = new Date().toISOString();
  let job = findJobForPage(db, body.url, body.referrer);
  let created = false;
  if (job && (job.status === "submitted" || job.status === "applied-manually")) return { ok: true, jobId: job.id, created: false, already: true };
  if (!job) {
    const id = randomUUID();
    const urlNorm = normalizeUrl(body.url);
    const company = body.company.trim() || companyFromUrl(body.url);
    const title = body.title.trim() || "Application";
    db.prepare(`INSERT INTO jobs (id, source_id, listing_id, company, title, locations, category, terms, url, url_norm,
        date_posted, active, status, role_key, updated_at, degrees) VALUES (?, 'extension', ?, ?, ?, '[]', NULL, '[]', ?, ?, ?, 1, 'new', ?, ?, NULL)`)
      .run(id, urlNorm, company, title, body.url, urlNorm, now, roleKey(company, title, []), now);
    setAts(db, id, atsNameFromUrl(body.url));
    job = getJob(db, id)!;
    created = true;
  }
  try {
    saveRecord(job.id, { screenshots: [], answers: (body.answers ?? []).map(a => ({ ...a, source: "extension" })), outcome: "submitted (browser extension)" });
  } catch { /* the record is a convenience */ }
  try { resolveNeedsYouForJob(db, job.id); clearBlockersForJob(db, job.id); } catch { /* the status below still stands */ }
  setStatus(db, job.id, "submitted", "Submitted by you with the browser extension");
  try {
    if (body.resumeUsed || body.coverLetterUsed) setUsedDocuments(db, job.id, body.resumeUsed ?? null, body.coverLetterUsed ?? "");
  } catch { /* the tracker columns are a convenience */ }
  void deps.closeLive?.(job.id).catch(() => {});
  try { void deps.syncTracker?.()?.catch(() => {}); } catch { /* the tracker must never affect a job */ }
  return { ok: true, jobId: job.id, created, already: false };
}

/** What the extension's own option matching needs from the profile. */
export function extHints(p: Profile, now = new Date()): ExtHints {
  return { place: { city: p.city ?? null, state: p.state ?? null, country: p.country ?? null }, inProgress: degreeInProgress(p.graduationMonth, now) };
}

/**
 * Maps a value the extension couldn't match onto the options a control showed, as the runner's recovery does
 * (runner.ts fillOne): adaptAnswer first (never an option outside the list, never "Other" for a real value). A name
 * the list lacks (otherEligible) first gets other names to search by (a searchable control, before `final`), then the
 * list's "Other" option, with the real value for the box it reveals.
 */
export async function adapt(deps: ExtDeps, body: z.infer<typeof AdaptSchema>): Promise<AdaptResponse> {
  const { db, llm } = deps;
  const job = findJobForPage(db, body.url, body.referrer);
  const ctx = jobContext(job, body.url, body.title ?? "", body.company);
  const options = [...new Set(body.options.map(o => o.replace(/\s+/g, " ").trim()).filter(Boolean))];
  const field = { ...body.field, options } as FieldSpec;
  const value = body.value;
  const text = Array.isArray(value) ? value.join(", ") : value;
  const otherAllowed = otherEligible(field, { source: body.source ?? "", answer: { type: "text", text }, ...(body.entity ? { entity: true } : {}) });
  if (options.length) {
    const profile = getProfile(db);
    const adapted = await adaptAnswer(llm, value, field, ctx, { inProgress: degreeInProgress(profile.graduationMonth) });
    if (adapted && adapted.type !== "file") return { answer: adapted, otherAllowed };
  }
  if (!otherAllowed) return { answer: null, otherAllowed };
  if (!body.final && field.kind === "combobox") {
    const variants = await nameVariants(llm, text, field, ctx).catch(() => [] as string[]);
    return { answer: null, otherAllowed, variants };
  }
  const other = findOtherOption(options);
  return other ? { answer: { type: "option", option: other }, other: text, otherAllowed } : { answer: null, otherAllowed };
}

/** Its name for upload: the file's own name unless it is the app's stored resume.pdf. */
function resumeName(p: Profile): string {
  const base = path.basename(p.resumePath ?? "resume.pdf");
  if (base !== "resume.pdf") return base;
  const name = [p.firstName, p.lastName].filter(Boolean).join("_").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  return name ? `${name}_Resume.pdf` : "Resume.pdf";
}

/** The /ext/* routes: CORS for the extension's origin, the pairing token on every request, then the API. */
export function extRoutes(app: Hono, deps: ExtDeps): void {
  const { db } = deps;
  app.use("/ext/*", async (c, next) => {
    const origin = c.req.header("origin");
    // Only the extension (or a request with no Origin, as a service worker's GET may be) reaches the API.
    if (origin && !isExtensionOrigin(origin)) return c.text("Forbidden: cross-site request", 403);
    const cors: Record<string, string> = origin ? {
      "access-control-allow-origin": origin, "vary": "Origin",
      "access-control-allow-headers": `content-type, ${TOKEN_HEADER.toLowerCase()}`, "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "600",
    } : {};
    if (c.req.method === "OPTIONS") return c.body(null, 204, cors);
    const token = c.req.header(TOKEN_HEADER) ?? "";
    if (!token || !sameToken(token, getExtToken(db))) {
      return c.json({ ok: false, error: "Pair the extension: paste the token from the app's Settings → Browser extension" }, 401, cors);
    }
    await next();
    for (const [k, v] of Object.entries(cors)) c.res.headers.set(k, v);
  });

  const parse = async <T extends z.ZodTypeAny>(schema: T, req: Request): Promise<z.infer<T> | null> => {
    try {
      const r = schema.safeParse(await req.json());
      return r.success ? r.data : null;
    } catch { return null; }
  };

  app.get("/ext/status", c => {
    const p = getProfile(db);
    const hasResume = !!p.resumePath && existsSync(p.resumePath);
    const body: StatusResponse = { ok: true, paused: getSettings(db).paused, profileComplete: !!(p.firstName && p.lastName && p.email && hasResume), hasResume };
    return c.json(body);
  });

  app.get("/ext/resume", c => {
    const p = getProfile(db);
    if (!p.resumePath || !existsSync(p.resumePath)) return c.json({ ok: false, error: "No resume uploaded in Profile" }, 404);
    return c.body(readFileSync(p.resumePath), 200, {
      "content-type": "application/pdf", "x-filename": encodeURIComponent(resumeName(p)), "access-control-expose-headers": "x-filename",
    });
  });

  app.post("/ext/resolve", async c => {
    const body = await parse(ResolveSchema, c.req.raw);
    if (!body) return c.json({ ok: false, error: "Bad request" }, 400);
    const job = findJobForPage(db, body.url, body.referrer);
    const ctx = jobContext(job, body.url, body.title, body.company);
    const fields = body.fields as FieldSpec[];
    try {
      const resolutions = await resolveFields({ db, llm: deps.llm }, fields, ctx);
      const out: ResolveResponse = {
        resolutions: await forExtension(deps, fields, resolutions, ctx, getProfile(db)),
        job: { id: job?.id ?? null, company: ctx.company, title: ctx.title },
        hints: extHints(getProfile(db)),
      };
      return c.json(out);
    } catch (e) {
      return c.json({ ok: false, error: `Couldn't work out the answers: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  });

  app.post("/ext/adapt", async c => {
    const body = await parse(AdaptSchema, c.req.raw);
    if (!body) return c.json({ ok: false, error: "Bad request" }, 400);
    try {
      return c.json(await adapt(deps, body));
    } catch (e) {
      return c.json({ ok: false, error: `Couldn't map the answer: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  });

  app.post("/ext/learn", async c => {
    const body = await parse(LearnSchema, c.req.raw);
    if (!body) return c.json({ ok: false, error: "Bad request" }, 400);
    return c.json(await learn(deps, body));
  });

  app.post("/ext/submitted", async c => {
    const body = await parse(SubmittedSchema, c.req.raw);
    if (!body) return c.json({ ok: false, error: "Bad request" }, 400);
    return c.json(submitted(deps, body));
  });
}
