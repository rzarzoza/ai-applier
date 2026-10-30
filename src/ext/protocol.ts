/**
 * The browser extension's API (/ext/*), shared by the app and the extension bundle. Types and constants only: the
 * extension imports this file, so it must not pull in anything from Node.
 */
import type { PlaceHint } from "../answers/choose.js";
import type { FieldAnswer, FieldKind, FieldSpec } from "../forms/types.js";

/** The header carrying the pairing token shown in Settings → Browser extension. */
export const TOKEN_HEADER = "X-AI-Applier-Token";

/** Where the extension looks for the app unless its options say otherwise. */
export const DEFAULT_API_BASE = "http://127.0.0.1:4310";

/** An answer as the extension can apply it: a file answer always means "the profile's resume" (GET /ext/resume). */
export type ExtAnswer = Exclude<FieldAnswer, { type: "file" }> | { type: "file"; resume: true };

export type ExtResolution =
  /**
   * Fill it with this value. `other`: the answer is the list's "Other" option; this real value goes in the box it
   * reveals. `entity`: the value is a name (school, degree, major, employer) a list may lack, so "Other" may stand in.
   */
  | { fieldId: string; status: "filled"; answer: ExtAnswer; source: string; other?: string; entity?: true }
  /** An unapproved draft (or a fact taken from the profile awaiting approval): never filled unless the user clicks. */
  | { fieldId: string; status: "suggestion"; suggestion: ExtAnswer; text: string; questionId: number }
  /** Only the user can answer it (or attach the file). */
  | { fieldId: string; status: "needs-you"; reason: "missing" | "approval" | "file"; questionId?: number }
  /** Left alone (an optional opt-in, an optional field with no known answer...). */
  | { fieldId: string; status: "skip" };

export interface ResolveRequest { url: string; referrer?: string; title: string; company?: string; fields: FieldSpec[] }
export interface ResolveResponse {
  resolutions: ExtResolution[];
  /** The job row the page was matched to, if any (its company and title were used). */
  job: { id: string | null; company: string; title: string };
  /** What the extension's own option matching needs from the profile (see answers/choose.ts). */
  hints?: ExtHints;
  /** Why the AI left some fields for the user ("AI budget reached for today", the local model is off...), when it did. */
  notice?: string;
}

export interface ExtHints {
  /** The applicant's city, state and country: a bare "Houston" is looked up as "Houston, Texas". */
  place: PlaceHint;
  /** Whether the applicant's degree is still in progress ("Currently pursuing a Bachelor's"), when known. */
  inProgress: boolean | null;
}

/**
 * A choice control had no option the extension could match to `value`: the app maps it onto `options` (the ones the
 * control showed) as the runner does (adaptAnswer: never an option outside the list, never "Other" for a real value).
 * `final`: the extension has searched everything it could; only then may a name (`entity`, or a bank answer to a
 * question asking for a name) fall back to the list's "Other" option.
 */
export interface AdaptRequest {
  url: string; referrer?: string; title?: string; company?: string;
  field: FieldSpec; value: string | string[]; options: string[];
  source?: string; entity?: boolean; final?: boolean;
}
export interface AdaptResponse {
  /** The option(s) to pick, or null when none states the value. */
  answer: ExtAnswer | null;
  /** The answer is the list's "Other" option: type this real value into the box it reveals. */
  other?: string;
  /** Other names the same entity is listed under, to search the control with before falling back to "Other". */
  variants?: string[];
  /** Whether "Other" may stand for this value (a name the list may lack). */
  otherAllowed: boolean;
}

export type LearnValue = string | string[] | boolean;
export interface LearnAnswer {
  label: string; kind: FieldKind; options?: string[]; value: LearnValue;
  /** Where the value the extension filled came from ("none" when it filled nothing); the user's value replaced it. */
  source?: string;
  /** The bank question the app named for this field (needs-you or suggestion), when it named one. */
  questionId?: number;
  /**
   * The value the app's answer was when the user replaced it by picking one of the options the extension offered: this
   * question then takes the picked option whenever the app's answer is that value again.
   */
  replaced?: string;
}
export interface LearnRequest { url: string; referrer?: string; title?: string; company?: string; answers: LearnAnswer[] }
export interface LearnResponse { ok: true; learned: number; overrides: number }

export interface SubmittedRequest {
  url: string;
  /** The page that led to this one (a one-click form's posting), to find the job row by. */
  referrer?: string;
  title: string; company: string; resumeUsed?: string; coverLetterUsed?: string;
  /** Every value sent, for the application's record. */
  answers?: { label: string; value: LearnValue }[];
}
export interface SubmittedResponse { ok: true; jobId: string; created: boolean; already: boolean }

export interface StatusResponse { ok: true; paused: boolean; profileComplete: boolean; hasResume: boolean }
