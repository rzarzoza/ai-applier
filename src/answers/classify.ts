import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { FieldSpec, JobContext } from "../forms/types.js";
import type { Llm } from "../llm/llm.js";
import { PROFILE_KEY_DESCRIPTIONS, type ProfileKey } from "../profile/profile.js";

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

For each field you receive its id, label, input kind, whether it is required, its options (if any) and a description (if any). Return one entry per field id with:

category, one of:
- "profile": the field asks directly for one of the applicant's stored facts listed under profileKeys, including yes/no versions of them (for example "Are you Hispanic or Latino?" is hispanicLatino; "Will you now or in the future require sponsorship?" is requiresSponsorship). Set profileKey to that key. Use it only when the stored fact answers the field exactly as asked; a question about a different scope or time frame is a "question".
- "derived": the answer comes from the app's records about this job: workedAtCompany ("Have you worked at {company} before?"), appliedToCompany ("Have you applied to {company} before?"), jobLocation (which office or location the applicant is applying for), jobTerm (which term, season or start period the applicant is applying for). Set derivedKey.
- "consent-required": a legal certification, attestation, privacy or data-processing consent, background-check consent, terms acknowledgment, or a field asking the applicant to type their name as an electronic signature.
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

export function fieldCacheKey(field: FieldSpec, company: string): string {
  const options = (field.options ?? []).map(o => normalizeLabel(o, company)).sort();
  return createHash("sha1").update([field.kind, normalizeLabel(field.label, company), options.join("\u001f")].join("|")).digest("hex");
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
    default:
      return { ...base, category: raw.category };
  }
}

/** Used when the classifier leaves a field out: treat it as a factual question so nothing is guessed. */
const fallback = (field: FieldSpec): Classification =>
  ({ category: "question", canonicalQuestion: field.label.trim(), isFactual: true, isCompanySpecific: false });

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
  const out = await llm.structured({
    name: "classify",
    schema: ClassifySchema,
    system: CLASSIFY_SYSTEM,
    effort: "low",
    content: JSON.stringify({
      company: job.company,
      jobTitle: job.title,
      profileKeys: Object.fromEntries(CLASSIFIABLE_PROFILE_KEYS.map(k => [k, PROFILE_KEY_DESCRIPTIONS[k]])),
      fields: toAsk.map(f => ({
        id: f.id, label: f.label, kind: f.kind, required: f.required, options: f.options ?? null, description: f.description ?? null,
      })),
    }),
  });

  const byId = new Map(out.fields.map(r => [r.id, r]));
  const insert = db.prepare("INSERT OR REPLACE INTO field_cache (key, classification_json, created_at) VALUES (?, ?, ?)");
  for (const [key, group] of missing) {
    const raw = byId.get(group[0]!.id);
    const c = raw ? sanitize(raw, group[0]!, job.company) : fallback(group[0]!);
    if (raw) insert.run(key, JSON.stringify(c), new Date().toISOString());
    for (const field of group) result.set(field.id, c);
  }
  return result;
}
