import type { Db } from "../db/db.js";
import type { FieldAnswer, FieldSpec, JobContext } from "../forms/types.js";
import { hasSubmittedToCompany } from "../jobs/repo.js";
import type { Llm } from "../llm/llm.js";
import { getProfile, profileValue, type Profile } from "../profile/profile.js";
import { adaptAnswer } from "./adapt.js";
import { addVariant, createQuestion, getOverrides, getQuestion, incrementUse, listQuestions, type Question } from "./bank.js";
import { classifyFields, normalizeLabel, withCompanyPlaceholder, type Classification, type DerivedKey } from "./classify.js";
import { draftAnswer, fillTemplate } from "./draft.js";
import { matchQuestion } from "./match.js";

export type FillSource = "override" | "profile" | "derived" | "consent" | "resume" | "bank" | "template";

export type Resolution =
  | { fieldId: string; status: "filled"; answer: FieldAnswer; source: FillSource }
  | { fieldId: string; status: "skip" }
  | { fieldId: string; status: "blocked"; questionId: number; reason: "missing" | "approval" };

interface Ctx { db: Db; llm: Llm; profile: Profile; job: JobContext }

type Value = string | boolean | string[] | null;

/** Kinds where consent is expressed by ticking or choosing "yes"/"I agree". */
const CHOICE_KINDS = new Set<FieldSpec["kind"]>(["checkbox", "checkbox-group", "select", "combobox", "radio"]);

const filled = (field: FieldSpec, answer: FieldAnswer, source: FillSource): Resolution => ({ fieldId: field.id, status: "filled", answer, source });
const skip = (field: FieldSpec): Resolution => ({ fieldId: field.id, status: "skip" });
const blocked = (field: FieldSpec, questionId: number, reason: "missing" | "approval"): Resolution =>
  ({ fieldId: field.id, status: "blocked", questionId, reason });

const cleanLabel = (label: string) => label.trim().replace(/\s*\*+$/, "").trim();
const nonEmpty = (v: Value): Value => (v === "" || (Array.isArray(v) && v.length === 0) ? null : v);

/**
 * Decides every field's value: a per-job override, then by classification the profile, the app's
 * records, consent rules, the resume, or the answer bank (matching, templates, AI drafts). Never
 * writes job_blockers; it may create questions and add variants.
 */
export async function resolveFields(deps: { db: Db; llm: Llm }, fields: FieldSpec[], job: JobContext): Promise<Resolution[]> {
  const { db, llm } = deps;
  const overrides = new Map(Object.entries(getOverrides(db, job.jobId)).map(([label, a]) => [normalizeLabel(label, ""), a]));
  const overrideFor = (f: FieldSpec) => overrides.get(normalizeLabel(f.label, ""));

  const toClassify = fields.filter(f => !overrideFor(f));
  const classes = toClassify.length ? await classifyFields(db, llm, toClassify, job) : new Map<string, Classification>();
  const ctx: Ctx = { db, llm, profile: getProfile(db), job };

  const out: Resolution[] = [];
  for (const field of fields) {
    const override = overrideFor(field);
    out.push(override ? filled(field, override, "override") : await byCategory(ctx, field, classes.get(field.id)!));
  }
  return out;
}

async function byCategory(ctx: Ctx, field: FieldSpec, c: Classification): Promise<Resolution> {
  switch (c.category) {
    case "profile":
      return fromValue(ctx, field, profileValue(ctx.profile, c.profileKey!), "profile");
    case "derived":
      return fromValue(ctx, field, derivedValue(ctx, c.derivedKey!), "derived");
    case "consent-required":
      if (field.kind === "text" || field.kind === "textarea") return fromValue(ctx, field, profileValue(ctx.profile, "fullName"), "consent");
      if (CHOICE_KINDS.has(field.kind)) return fromValue(ctx, field, true, "consent");
      return unresolvedFact(ctx, field);
    case "optin-optional":
      return skip(field);
    case "resume":
      if (field.kind !== "file") return fromValue(ctx, field, ctx.profile.resumeText, "profile");
      return ctx.profile.resumePath ? filled(field, { type: "file", path: ctx.profile.resumePath }, "resume") : unresolvedFact(ctx, field);
    case "cover-letter":
      return field.required ? fromBank(ctx, field, c) : skip(field);
    case "question":
      return fromBank(ctx, field, c);
  }
}

function derivedValue({ db, profile, job }: Ctx, key: DerivedKey): Value {
  switch (key) {
    case "workedAtCompany":
      return workedAt(profile.employers, job.company);
    case "appliedToCompany":
      return hasSubmittedToCompany(db, job.company);
    case "jobLocation":
      return job.location || null;
    case "jobTerm":
      return job.term;
  }
}

const LEGAL_SUFFIXES = new Set(["inc", "incorporated", "corp", "corporation", "llc", "ltd", "limited", "co", "company", "technologies", "plc"]);

function companyName(s: string): string {
  const words = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

/**
 * True when an employer is the company (equal after dropping legal suffixes, so "Acme Corp" is
 * "Acme"). Null when an employer only overlaps it ("H&R Block" vs "Block"), since that can't be
 * told apart safely; false otherwise. Null employers means unknown.
 */
function workedAt(employers: string[] | null, company: string): boolean | null {
  if (employers === null) return null;
  const c = companyName(company);
  if (!c) return null;
  const names = employers.map(companyName).filter(Boolean);
  if (names.some(e => e === c)) return true;
  if (names.some(e => ` ${e} `.includes(` ${c} `) || ` ${c} `.includes(` ${e} `))) return null;
  return false;
}

/** Fills from a known value; if there is none or it doesn't fit the field, falls back to the user's own answer. */
async function fromValue(ctx: Ctx, field: FieldSpec, value: Value, source: FillSource): Promise<Resolution> {
  const v = nonEmpty(value);
  if (v !== null) {
    const answer = await adaptAnswer(ctx.llm, v, field, ctx.job);
    if (answer) return filled(field, answer, source);
  }
  return unresolvedFact(ctx, field);
}

/**
 * A fixed fact we couldn't fill. Uses the user's approved answer to this exact label if there is one;
 * otherwise blocks (required) on a factual global question whose canonical text is the label, or skips.
 */
async function unresolvedFact(ctx: Ctx, field: FieldSpec): Promise<Resolution> {
  const { db, llm, job } = ctx;
  const key = normalizeLabel(field.label, job.company);
  // Template answers are written for some other company, so they are never reused verbatim here.
  const existing = listQuestions(db).find(q => q.kind !== "template" && [q.canonical, ...q.variants].some(t => normalizeLabel(t, job.company) === key));

  if (existing?.status === "approved" && existing.answer !== null) {
    const answer = await adaptAnswer(llm, existing.answer, field, job);
    if (answer) {
      incrementUse(db, existing.id);
      return filled(field, answer, "bank");
    }
  }
  if (!field.required) return skip(field);

  const q = existing ?? createQuestion(db, {
    canonical: withCompanyPlaceholder(cleanLabel(field.label), job.company), kind: "global", isFactual: true, options: field.options ?? null,
  });
  addVariant(db, q.id, field.label);
  return blocked(field, q.id, q.status === "draft" ? "approval" : "missing");
}

/** The question path: reuse a matching bank entry, or create one (drafted when it's open-ended). */
async function fromBank(ctx: Ctx, field: FieldSpec, c: Classification): Promise<Resolution> {
  const { db, llm, profile, job } = ctx;
  const canonical = c.canonicalQuestion ?? cleanLabel(field.label);
  // A file can't be drafted, so treat it like a fact only the user can provide.
  const isFactual = c.isFactual || field.kind === "file";

  const label = cleanLabel(field.label);
  const matchId = await matchQuestion(llm, canonical, isFactual, listQuestions(db), [label, withCompanyPlaceholder(label, job.company)]);
  const matched = matchId === null ? null : getQuestion(db, matchId);
  if (matched) {
    addVariant(db, matched.id, field.label);
    return fromMatched(ctx, field, matched);
  }

  const kind = c.isCompanySpecific ? "template" : "global";
  const create = (draft: string | null) => {
    const q = createQuestion(db, { canonical, kind: isFactual ? "global" : kind, isFactual, options: field.options ?? null, draft });
    addVariant(db, q.id, field.label);
    return q;
  };

  if (isFactual) {
    const q = create(null);
    return field.required ? blocked(field, q.id, "missing") : skip(field);
  }
  const { answerable, draft } = await draftAnswer(llm, profile, canonical, field, job);
  if (answerable) {
    // Even an optional field waits for approval, so every draft is reviewed once before it is sent.
    return blocked(field, create(draft).id, "approval");
  }
  const q = create(null);
  return field.required ? blocked(field, q.id, "missing") : skip(field);
}

async function fromMatched(ctx: Ctx, field: FieldSpec, q: Question): Promise<Resolution> {
  const { db, llm, profile, job } = ctx;
  if (q.status === "draft") return blocked(field, q.id, "approval");
  if (q.status === "approved" && q.answer !== null) {
    const isTemplate = q.kind === "template";
    const text = isTemplate ? await fillTemplate(llm, profile, q.answer, field, job) : q.answer;
    const answer = await adaptAnswer(llm, text, field, job);
    if (answer) {
      incrementUse(db, q.id);
      return filled(field, answer, isTemplate ? "template" : "bank");
    }
  }
  return field.required ? blocked(field, q.id, "missing") : skip(field);
}
