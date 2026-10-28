import { z } from "zod";
import type { FieldSpec, JobContext } from "../forms/types.js";
import type { Llm } from "../llm/llm.js";
import type { Profile } from "../profile/profile.js";

const DRAFT_SYSTEM = `You draft answers to job application questions for one applicant, writing in their first-person voice.

The applicant's resume and profile are provided. Use only facts stated there. Do not invent experience, projects, skills, employers, dates, numbers, or motivations the resume and profile do not support, and do not exaggerate what they say.

You receive the question, the form field (its kind, options, and character limit if any), and the job (company, title, and description if available). "{company}" in the question stands for the job's company.

Set answerable to false, with a null draft, when:
- the question asks for a fact about the applicant that the resume and profile do not state (work authorization, sponsorship, citizenship, dates, availability, GPA, demographics, prior employment, salary, references, and similar), or
- a truthful, specific answer cannot be written from the resume and profile.

Otherwise set answerable to true and write the draft:
- If the field has options, the draft must be exactly one of the options.
- Stay within the character limit if there is one.
- Be specific and concise; plain prose, no headings, no placeholders.`;

const REVISE_SYSTEM = `You revise a draft answer to a job application question, written in the applicant's first-person voice, following the applicant's instruction.

The applicant's resume and profile are provided. Apply the instruction, and keep every other part of the draft as it is unless the instruction requires changing it. Use only facts stated in the resume, profile, draft, or instruction; do not invent experience, projects, skills, employers, dates, or numbers.`;

const TEMPLATE_SYSTEM = `You adapt an applicant's approved answer template to a specific job application.

The template was written by or approved by the applicant, possibly for a different company, and may contain "{company}" as a placeholder. Rewrite it for the given company and job: replace company names and company-specific details, and connect it to the job title and description where the template already makes that kind of point.

Keep the template's structure, length, voice, and claims about the applicant. Use only facts about the applicant that appear in the template, resume, or profile; do not invent experience or skills. Do not state facts about the company that are not in the job description. Stay within the character limit if there is one. Return only the answer text.`;

const FACT_SYSTEM = `You answer factual job application questions for one applicant, only from what their profile and resume state.

The applicant's resume and profile are provided. You receive the question, the form field (its label, kind, options, character limit, and any section heading or helper text in its description), and the job. "{company}" in the question stands for the job's company.

Answer ONLY when the answer follows directly from a stated profile field or explicit resume text. Otherwise set answerable to false, with a null answer and a null basis.
- Name the basis: the profile field and its value (for example "profile.usCitizen = true") or the resume text you used (for example "resume: Onshape (PTC), Software Engineering Intern, May 2025 – Aug 2025").
- If the field has options, the answer must be exactly one of the options, copied character for character. If no option fits, the question is not answerable.
- Never guess. Never infer intent, preferences, plans, or circumstances that are not stated (relocation, salary, how they heard about the job, relatives at the company, and similar) unless a profile field states them.
- Never invent dates. Use a date only as the profile or resume writes it, reformatted only when the field asks for a specific format (for example "May 2025" as "05/2025").
- Mind polarity: answer what the field literally asks. A U.S. citizen answers "Yes" to "Are you a U.S. citizen, U.S. national, lawful permanent resident, or protected individual?"; someone who does not require sponsorship answers "No" to "Will you require sponsorship?".
- For a follow-up such as "If you answered No above, explain… otherwise N/A", answer "N/A" only when the profile makes the earlier answer Yes; otherwise it is not answerable.
- Employment fields (company, title, start or end date) in an employment or experience section refer to the applicant's most recent role on the resume, unless the section says otherwise. An end date is answerable only when the resume states it.
- Keep the answer short: the value itself, not a sentence, unless the field is a free-text question that needs one.`;

const DraftSchema = z.object({ answerable: z.boolean(), draft: z.string().nullable() });
const FactSchema = z.object({ answerable: z.boolean(), answer: z.string().nullable(), basis: z.string().nullable() });
const ReviseSchema = z.object({ draft: z.string() });
const TemplateSchema = z.object({ text: z.string() });

/** Demographic and EEO facts never belong in a written answer, so they stay out of the drafting context. */
const EXCLUDED: (keyof Profile)[] = [
  "resumeText", "resumePath", "gender", "sexualOrientation", "pronouns", "ethnicity", "hispanicLatino",
  "veteranStatus", "militarySpouse", "disabilityStatus",
];

/** Stable per profile, so it is sent as cached context across draft, revise and template calls. */
function applicantContext(profile: Profile): string {
  const facts = Object.fromEntries(Object.entries(profile).filter(([k, v]) => !EXCLUDED.includes(k as keyof Profile) && v !== null));
  return `<resume>\n${profile.resumeText?.trim() || "(no resume text available)"}\n</resume>\n\n<profile>\n${JSON.stringify(facts, null, 2)}\n</profile>`;
}

const fieldInfo = (field: FieldSpec) => ({ label: field.label, kind: field.kind, options: field.options ?? null, maxLength: field.maxLength ?? null });
const factFieldInfo = (field: FieldSpec) => ({ ...fieldInfo(field), description: field.description ?? null });
const jobInfo = (job: JobContext) => ({ company: job.company, title: job.title, location: job.location, term: job.term, description: job.description ?? null });

export async function draftAnswer(llm: Llm, profile: Profile, canonical: string, field: FieldSpec, job: JobContext): Promise<{ answerable: boolean; draft: string | null }> {
  const out = await llm.structured({
    name: "draft",
    schema: DraftSchema,
    system: DRAFT_SYSTEM,
    cachedContext: applicantContext(profile),
    effort: "medium",
    content: JSON.stringify({ question: canonical, field: fieldInfo(field), job: jobInfo(job) }),
  });
  const draft = out.draft?.trim() || null;
  return out.answerable && draft ? { answerable: true, draft } : { answerable: false, draft: null };
}

/**
 * Answers a factual question only from what the profile or resume states, naming the basis. An answer
 * to a field with options must be exactly one of them, or the question counts as not answerable.
 */
export async function factAnswer(llm: Llm, profile: Profile, canonical: string, field: FieldSpec, job: JobContext):
  Promise<{ answerable: boolean; answer: string | null; basis: string | null }> {
  const out = await llm.structured({
    name: "fact",
    schema: FactSchema,
    system: FACT_SYSTEM,
    cachedContext: applicantContext(profile),
    effort: "low",
    content: JSON.stringify({ question: canonical, field: factFieldInfo(field), job: jobInfo(job) }),
  });
  const none = { answerable: false, answer: null, basis: null };
  const answer = out.answer?.trim() || null;
  if (!out.answerable || !answer) return none;
  if (field.options?.length && !field.options.includes(answer)) return none;
  return { answerable: true, answer, basis: out.basis?.trim() || null };
}

export async function reviseDraft(llm: Llm, profile: Profile, canonical: string, draft: string, instruction: string): Promise<string> {
  const out = await llm.structured({
    name: "revise",
    schema: ReviseSchema,
    system: REVISE_SYSTEM,
    cachedContext: applicantContext(profile),
    effort: "medium",
    content: JSON.stringify({ question: canonical, draft, instruction }),
  });
  return out.draft.trim();
}

export async function fillTemplate(llm: Llm, profile: Profile, template: string, field: FieldSpec, job: JobContext): Promise<string> {
  const out = await llm.structured({
    name: "template",
    schema: TemplateSchema,
    system: TEMPLATE_SYSTEM,
    cachedContext: applicantContext(profile),
    effort: "medium",
    content: JSON.stringify({ template, field: fieldInfo(field), job: jobInfo(job) }),
  });
  return out.text.trim();
}
