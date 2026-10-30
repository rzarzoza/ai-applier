import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { Llm } from "../llm/llm.js";
import { paths } from "../paths.js";
import { getProfile, ProfileSchema, saveProfile, type Profile } from "./profile.js";

const ResumeSchema = ProfileSchema.pick({
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  addressLine: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  linkedin: true,
  github: true,
  website: true,
  school: true,
  degree: true,
  major: true,
  gpa: true,
  graduationMonth: true,
  employers: true,
  resumeText: true,
});

const SYSTEM =
  "You extract applicant details from a resume PDF. Return null for anything not stated in the resume; " +
  "never guess. graduationMonth must be formatted YYYY-MM. employers lists employer names only. " +
  "resumeText is the full plain text of the resume.";

const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

export async function importResume(db: Db, llm: Llm, pdfPath: string): Promise<Profile> {
  mkdirSync(path.dirname(paths.resume), { recursive: true });
  copyFileSync(pdfPath, paths.resume);
  const data = readFileSync(paths.resume).toString("base64");

  const extracted = await llm.structured({
    name: "resume",
    schema: ResumeSchema,
    system: SYSTEM,
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
      { type: "text", text: "Extract the applicant's details from this resume." },
    ],
    effort: "medium",
  });

  const current = getProfile(db);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extracted)) {
    if (key === "resumeText" || isEmpty(value)) continue;
    if (isEmpty(current[key as keyof Profile])) patch[key] = value;
  }
  return saveProfile(db, {
    ...(patch as Partial<Profile>),
    resumePath: paths.resume,
    resumeText: extracted.resumeText ?? current.resumeText,
  });
}
