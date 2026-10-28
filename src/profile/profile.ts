import { z } from "zod";
import type { Db } from "../db/db.js";
import { getJson, setJson } from "../settings.js";

const str = z.string().nullable();
const bool = z.boolean().nullable();

export const ProfileSchema = z.object({
  firstName: str,
  lastName: str,
  preferredName: str,
  email: str,
  phone: str,
  addressLine: str,
  city: str,
  state: str,
  postalCode: str,
  country: str,
  linkedin: str,
  github: str,
  website: str,
  school: str,
  degree: str,
  major: str,
  gpa: str,
  graduationMonth: str, // "YYYY-MM"
  employers: z.array(z.string()).nullable(),
  usCitizen: bool,
  workAuthorizedUS: bool,
  requiresSponsorship: bool,
  willingToRelocate: bool,
  earliestStart: str,
  gender: str,
  sexualOrientation: str,
  pronouns: str,
  ethnicity: str,
  hispanicLatino: bool,
  veteranStatus: str,
  militarySpouse: bool,
  disabilityStatus: str,
  relatedToEmployee: bool,
  resumePath: str,
  resumeText: str,
});

export type Profile = z.infer<typeof ProfileSchema>;

export const PROFILE_DEFAULTS: Profile = {
  firstName: null,
  lastName: null,
  preferredName: null,
  email: null,
  phone: null,
  addressLine: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  linkedin: null,
  github: null,
  website: null,
  school: null,
  degree: null,
  major: null,
  gpa: null,
  graduationMonth: null,
  employers: [],
  usCitizen: true,
  workAuthorizedUS: true,
  requiresSponsorship: false,
  willingToRelocate: null,
  earliestStart: null,
  gender: "Male",
  sexualOrientation: "Heterosexual / Straight",
  pronouns: "He/Him",
  ethnicity: "Hispanic or Latino",
  hispanicLatino: true,
  veteranStatus: "I am not a protected veteran",
  militarySpouse: false,
  disabilityStatus: "I do not want to answer",
  relatedToEmployee: null,
  resumePath: null,
  resumeText: null,
};

export type ProfileKey = keyof Profile | "fullName" | "graduationYear" | "location";

export const PROFILE_KEY_DESCRIPTIONS: Record<ProfileKey, string> = {
  firstName: "The applicant's first (given) name",
  lastName: "The applicant's last (family) name",
  preferredName: "The name the applicant prefers to be called, if different from the legal first name",
  email: "The applicant's email address",
  phone: "The applicant's phone number",
  addressLine: "The applicant's street address (line 1)",
  city: "The city where the applicant lives",
  state: "The state or province where the applicant lives",
  postalCode: "The applicant's ZIP or postal code",
  country: "The country where the applicant lives",
  linkedin: "The applicant's LinkedIn profile URL",
  github: "The applicant's GitHub profile URL",
  website: "The applicant's personal website or portfolio URL",
  school: "The university or college the applicant attends or most recently attended",
  degree: "The degree the applicant is pursuing or holds (e.g. Bachelor of Science)",
  major: "The applicant's major or field of study",
  gpa: "The applicant's GPA",
  graduationMonth: "The month and year of expected or actual graduation (YYYY-MM)",
  employers: "The list of employers the applicant has worked for (names only)",
  usCitizen: "Whether the applicant is a US citizen (yes/no)",
  workAuthorizedUS: "Whether the applicant is legally authorized to work in the United States (yes/no)",
  requiresSponsorship: "Whether the applicant now or in the future requires visa sponsorship to work (yes/no)",
  willingToRelocate: "Whether the applicant is willing to relocate (yes/no)",
  earliestStart: "The earliest date the applicant can start working",
  gender: "The applicant's gender (e.g. Male, Female, Non-binary)",
  sexualOrientation: "The applicant's sexual orientation",
  pronouns: "The applicant's pronouns (e.g. He/Him)",
  ethnicity: "The applicant's race or ethnicity",
  hispanicLatino: "Whether the applicant is Hispanic or Latino (yes/no)",
  veteranStatus: "The applicant's protected veteran status",
  militarySpouse: "Whether the applicant is a military spouse (yes/no)",
  disabilityStatus: "The applicant's disability status (self-identification)",
  relatedToEmployee: "Whether the applicant is related to an employee of the company (yes/no)",
  resumePath: "The applicant's resume file, to be uploaded in a file input",
  resumeText: "The full plain text of the applicant's resume",
  fullName: "The applicant's full name (first and last name together)",
  graduationYear: "The four-digit year of the applicant's expected or actual graduation",
  location: "The applicant's current location as 'city, state'",
};

export function profileValue(p: Profile, key: ProfileKey): string | string[] | boolean | null {
  switch (key) {
    case "fullName": {
      const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
      return name || null;
    }
    case "graduationYear":
      return p.graduationMonth?.match(/^(\d{4})/)?.[1] ?? null;
    case "location": {
      const loc = [p.city, p.state].filter(Boolean).join(", ");
      return loc || null;
    }
    default:
      return p[key];
  }
}

const PROFILE_KEY = "profile";

export function getProfile(db: Db): Profile {
  return { ...PROFILE_DEFAULTS, ...getJson<Partial<Profile>>(db, PROFILE_KEY, {}) };
}

export function saveProfile(db: Db, patch: Partial<Profile>): Profile {
  const next = { ...getProfile(db), ...patch };
  setJson(db, PROFILE_KEY, next);
  return next;
}
