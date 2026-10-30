import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { FieldSpec, JobContext } from "../forms/types.js";
import { LlmUnavailableError, type Llm } from "../llm/llm.js";
import { PROFILE_KEY_DESCRIPTIONS, type ProfileKey } from "../profile/profile.js";
import { MAX_LLM_OPTIONS } from "./rank.js";

export type FieldCategory = "profile" | "derived" | "consent-required" | "optin-optional" | "resume" | "cover-letter" | "question";
export type DerivedKey = "workedAtCompany" | "appliedToCompany" | "jobLocation" | "jobTerm";

export interface Classification {
  category: FieldCategory;
  profileKey?: ProfileKey;
  derivedKey?: DerivedKey;
  canonicalQuestion?: string;
  isFactual: boolean;
  isCompanySpecific: boolean;
}

const CATEGORIES = ["profile", "derived", "consent-required", "optin-optional", "resume", "cover-letter", "question"] as const;
const DERIVED_KEYS = ["workedAtCompany", "appliedToCompany", "jobLocation", "jobTerm"] as const;

/** Profile keys the classifier may pick. The resume file is its own category, never a text value. */
const CLASSIFIABLE_PROFILE_KEYS = (Object.keys(PROFILE_KEY_DESCRIPTIONS) as ProfileKey[]).filter(k => k !== "resumePath");

const ClassifySchema = z.object({
  fields: z.array(z.object({
    id: z.string(),
    category: z.enum(CATEGORIES),
    profileKey: z.string().nullable(),
    derivedKey: z.enum(DERIVED_KEYS).nullable(),
    canonicalQuestion: z.string().nullable(),
    isFactual: z.boolean(),
    isCompanySpecific: z.boolean(),
  })),
});

const CLASSIFY_SYSTEM = `You classify the fields of a job application form so an app can fill them for one applicant.

For each field you receive its id, label, input kind, whether it is required, its options (if any; a long list is cut short, with optionCount giving its full length) and a description (if any). Return one entry per field id with:

category, one of:
- "profile": the field asks directly for one of the applicant's stored facts listed under profileKeys, including yes/no versions of them (for example "Are you Hispanic or Latino?" is hispanicLatino; "Will you now or in the future require sponsorship?" is requiresSponsorship). Set profileKey to that key. Use it only when the stored fact answers the field exactly as asked; a question about a different scope or time frame is a "question". Mind polarity: if a "yes" to the field would mean the stored fact is false (for example "Are you able to work without sponsorship?" against requiresSponsorship), classify it as "question" instead. A field asking to repeat a stored fact to confirm it ("Confirm your email", "Re-enter email address") is that same fact's profileKey. The country or dialing-code picker beside a phone number (options like "+1" or "United States (+1)") is country.
- "derived": the answer comes from the app's records about this job: workedAtCompany ("Have you worked at {company} before?"), appliedToCompany ("Have you applied to {company} before?"), jobLocation (which office or location the applicant is applying for), jobTerm (which term, season or start period the applicant is applying for). Set derivedKey. The same polarity rule applies: if a "yes" to the field would mean the derived fact is false (for example "Is this your first application to {company}?"), classify it as "question".
- "consent-required": only a certification that the submitted information is accurate, a privacy or data-processing consent, a terms acknowledgment, permission for a background check, or a field asking the applicant to type their name as an electronic signature. An attestation of a specific fact about the applicant (for example "I certify that I am legally authorized to work in the US" or "I confirm I am 18 or older"; also sponsorship, citizenship, clearance, prior employment) is not consent: use "profile" if a profileKey states that fact with the same polarity, otherwise a factual "question".
- "optin-optional": SMS, marketing, newsletter, job-alert or talent-community opt-ins.
- "resume": a resume or CV file upload.
- "cover-letter": a cover letter, as a file upload or a text field.
- "question": anything else.

canonicalQuestion: for "question" fields, a short, self-contained, neutral wording of what the field asks, so the same question on another form can be recognized. Write {company} wherever the company's name would appear. Null for other categories.

isFactual: true when the correct answer is a fact about the applicant that cannot be composed from their resume. This includes work authorization, sponsorship, citizenship, visas, security clearance, dates and availability, GPA and test scores, demographics and EEO questions, prior employment or applications, relatives at the company, salary expectations, and how they heard about the job. False for open-ended prompts that can be answered from the resume, such as "Describe a project you're proud of" or "Why are you interested in this role?". When unsure, use true.

isCompanySpecific: true when a good answer depends on the specific company or job (for example "Why do you want to work at {company}?"), false otherwise.`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the company's name (case-insensitive, whole words) with "{company}". */
export function withCompanyPlaceholder(text: string, company: string): string {
  const c = norm(company);
  if (!c) return text;
  const pattern = escapeRe(c).replace(/ /g, "\\s+");
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "gi"), "{company}");
}

/** Lowercase, collapse whitespace, strip a trailing "*", and replace the company's name with "{company}". */
export function normalizeLabel(label: string, company: string): string {
  return withCompanyPlaceholder(norm(label).replace(/\s*\*+$/, "").trim(), company);
}

/**
 * Fields with the same key share one classification (cached across forms, and grouped within a form).
 * The description is part of it: two "I agree" boxes can be a required consent and an optional SMS opt-in.
 */
export function fieldCacheKey(field: FieldSpec, company: string): string {
  const options = (field.options ?? []).map(o => normalizeLabel(o, company)).sort();
  const description = withCompanyPlaceholder(norm(field.description ?? ""), company);
  return createHash("sha1").update([field.kind, normalizeLabel(field.label, company), options.join("\u001f"), description].join("|")).digest("hex");
}

type Raw = z.infer<typeof ClassifySchema>["fields"][number];

/** Turns a raw classifier entry into a Classification, routing anything inconsistent to the question path. */
function sanitize(raw: Raw, field: FieldSpec, company: string): Classification {
  const base = { isFactual: raw.isFactual, isCompanySpecific: raw.isCompanySpecific };
  const canonical = withCompanyPlaceholder((raw.canonicalQuestion ?? "").trim() || field.label.trim(), company);
  switch (raw.category) {
    case "profile":
      if (raw.profileKey && (CLASSIFIABLE_PROFILE_KEYS as string[]).includes(raw.profileKey)) {
        return { ...base, category: "profile", profileKey: raw.profileKey as ProfileKey };
      }
      // The field asks for a fixed fact we don't store: never let it be drafted.
      return { category: "question", canonicalQuestion: canonical, isFactual: true, isCompanySpecific: raw.isCompanySpecific };
    case "derived":
      if (raw.derivedKey) return { ...base, category: "derived", derivedKey: raw.derivedKey };
      return { category: "question", canonicalQuestion: canonical, isFactual: true, isCompanySpecific: raw.isCompanySpecific };
    case "question":
    case "cover-letter":
      return { ...base, category: raw.category, canonicalQuestion: canonical };
    case "resume":
      // Only an upload that asks for the resume gets it: a local model filed transcript and work-sample uploads here.
      if (field.kind === "file" && !RESUME_LABEL.test(`${field.label} ${field.description ?? ""}`)) {
        return { category: "question", canonicalQuestion: canonical, isFactual: true, isCompanySpecific: raw.isCompanySpecific };
      }
      return { ...base, category: raw.category };
    default:
      return { ...base, category: raw.category };
  }
}

const RESUME_LABEL = /(?<![a-z])(resume|résumé|cv|curriculum vitae)(?![a-z])/i;

/** Fields classified per LLM request. */
const CLASSIFY_CHUNK = 10;

/** Used when the classifier leaves a field out: treat it as a factual question so nothing is guessed. */
const fallback = (field: FieldSpec): Classification =>
  ({ category: "question", canonicalQuestion: field.label.trim(), isFactual: true, isCompanySpecific: false });

async function unlessUnavailable<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof LlmUnavailableError) return null;
    throw err;
  }
}

/**
 * Classifies every field, reading from field_cache first and making at most one LLM call for the
 * fields not seen before. Returns a map keyed by field id.
 */
export async function classifyFields(db: Db, llm: Llm, fields: FieldSpec[], job: JobContext): Promise<Map<string, Classification>> {
  const result = new Map<string, Classification>();
  const getCached = db.prepare("SELECT classification_json FROM field_cache WHERE key = ?");
  const missing = new Map<string, FieldSpec[]>(); // cache key -> fields sharing it

  for (const field of fields) {
    const key = fieldCacheKey(field, job.company);
    const row = getCached.get(key) as { classification_json: string } | undefined;
    if (row) result.set(field.id, JSON.parse(row.classification_json) as Classification);
    else missing.set(key, [...(missing.get(key) ?? []), field]);
  }
  if (missing.size === 0) return result;

  const toAsk = [...missing.values()].map(group => group[0]!);
  const profileKeys = Object.fromEntries(CLASSIFIABLE_PROFILE_KEYS.map(k => [k, PROFILE_KEY_DESCRIPTIONS[k]]));
  const insert = db.prepare("INSERT OR REPLACE INTO field_cache (key, classification_json, created_at) VALUES (?, ?, ?)");
  const keyOf = new Map([...missing].map(([key, group]) => [group[0]!.id, key]));
  const byId = new Map<string, Raw>();
  // A few fields per request, so a local model answers each well within its time limit; each part is cached as soon as
  // it is classified.
  for (let i = 0; i < toAsk.length; i += CLASSIFY_CHUNK) {
    const part = toAsk.slice(i, i + CLASSIFY_CHUNK);
    // When no model is available (the local one is off or too slow, or today's Claude budget is spent), the fields not
    // classified yet get the fallback (not cached: they are classified for real next time). An unusable answer still
    // fails the request.
    const out = await unlessUnavailable(llm.structured({
      name: "classify",
      schema: ClassifySchema,
      system: CLASSIFY_SYSTEM,
      effort: "low",
      content: JSON.stringify({
        company: job.company,
        jobTitle: job.title,
        profileKeys,
        fields: part.map(f => ({
          id: f.id, label: f.label, kind: f.kind, required: f.required, options: f.options?.slice(0, MAX_LLM_OPTIONS) ?? null,
          ...(f.options && f.options.length > MAX_LLM_OPTIONS ? { optionCount: f.options.length } : {}), description: f.description ?? null,
        })),
      }),
    }));
    if (!out) break;
    const asked = new Set(part.map(f => f.id));
    for (const raw of out.fields) {
      if (!asked.has(raw.id) || byId.has(raw.id)) continue;
      byId.set(raw.id, raw);
      const field = part.find(f => f.id === raw.id)!;
      insert.run(keyOf.get(raw.id)!, JSON.stringify(sanitize(raw, field, job.company)), new Date().toISOString());
    }
  }

  for (const group of missing.values()) {
    const raw = byId.get(group[0]!.id);
    const c = raw ? sanitize(raw, group[0]!, job.company) : fallback(group[0]!);
    for (const field of group) result.set(field.id, c);
  }
  return result;
}
