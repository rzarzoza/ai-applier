import { execFile } from "node:child_process";
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

/** For a resume whose text was already read from the PDF: the same fields, without copying the text back out. */
const TextResumeSchema = ResumeSchema.omit({ resumeText: true });
const TEXT_SYSTEM =
  "You extract applicant details from the text of a resume. Return null for anything not stated in the resume; " +
  "never guess. graduationMonth must be formatted YYYY-MM (the month of the expected or past graduation). " +
  "employers lists employer names only (companies, labs, organizations), not job titles.";

const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

// Static script (the path is an argument): macOS's PDFKit reads the PDF's text, so no model needs to read the PDF.
const PDF_TEXT_JXA = `function run(argv) {
  ObjC.import("PDFKit");
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return "";
  const text = doc.string;
  return text && !text.isNil() ? ObjC.unwrap(text) : "";
}`;

/** The PDF's text (empty when it has none or can't be read), extracted on this Mac without any model. */
export function pdfText(file: string): Promise<string> {
  return new Promise(resolve => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", PDF_TEXT_JXA, file], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => resolve(err ? "" : stdout.trim()));
  });
}

/**
 * Copies the resume into the app and fills the profile's empty fields from it. The PDF's text is read on this Mac and
 * sent to the model as text (any model can read it, the local one included); only a PDF without readable text is sent
 * as a document, which needs Claude.
 */
export async function importResume(db: Db, llm: Llm, pdfPath: string, readText: (file: string) => Promise<string> = pdfText): Promise<Profile> {
  mkdirSync(path.dirname(paths.resume), { recursive: true });
  copyFileSync(pdfPath, paths.resume);
  const text = await readText(paths.resume).catch(() => "");

  let extracted: z.infer<typeof ResumeSchema>;
  if (text) {
    const fields = await llm.structured({
      name: "resume",
      schema: TextResumeSchema,
      system: TEXT_SYSTEM,
      content: `<resume>\n${text}\n</resume>\n\nExtract the applicant's details from this resume.`,
      effort: "medium",
    });
    extracted = { ...fields, resumeText: text };
  } else {
    const data = readFileSync(paths.resume).toString("base64");
    extracted = await llm.structured({
      name: "resume",
      schema: ResumeSchema,
      system: SYSTEM,
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
        { type: "text", text: "Extract the applicant's details from this resume." },
      ],
      effort: "medium",
    });
  }

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
