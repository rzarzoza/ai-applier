/**
 * The browser extension's API (/ext/*), shared by the app and the extension bundle. Types and constants only: the
 * extension imports this file, so it must not pull in anything from Node.
 */
import type { FieldAnswer, FieldKind, FieldSpec } from "../forms/types.js";

/** The header carrying the pairing token shown in Settings → Browser extension. */
export const TOKEN_HEADER = "X-AI-Applier-Token";

/** Where the extension looks for the app unless its options say otherwise. */
export const DEFAULT_API_BASE = "http://127.0.0.1:4310";

/** An answer as the extension can apply it: a file answer always means "the profile's resume" (GET /ext/resume). */
export type ExtAnswer = Exclude<FieldAnswer, { type: "file" }> | { type: "file"; resume: true };

export type ExtResolution =
  /** Fill it with this value. `other`: the answer is the list's "Other" option; this real value goes in the box it reveals. */
  | { fieldId: string; status: "filled"; answer: ExtAnswer; source: string; other?: string }
  /** An unapproved draft (or a fact taken from the profile awaiting approval): never filled unless the user clicks. */
  | { fieldId: string; status: "suggestion"; suggestion: ExtAnswer; text: string; questionId: number }
  /** Only the user can answer it (or attach the file). */
  | { fieldId: string; status: "needs-you"; reason: "missing" | "approval" | "file"; questionId?: number }
  /** Left alone (an optional opt-in, an optional field with no known answer...). */
  | { fieldId: string; status: "skip" };

export interface ResolveRequest { url: string; title: string; company?: string; fields: FieldSpec[] }
export interface ResolveResponse {
  resolutions: ExtResolution[];
  /** The job row the page was matched to, if any (its company and title were used). */
  job: { id: string | null; company: string; title: string };
}

export type LearnValue = string | string[] | boolean;
export interface LearnAnswer {
  label: string; kind: FieldKind; options?: string[]; value: LearnValue;
  /** Where the value the extension filled came from ("none" when it filled nothing); the user's value replaced it. */
  source?: string;
  /** The bank question the app named for this field (needs-you or suggestion), when it named one. */
  questionId?: number;
}
export interface LearnRequest { url: string; title?: string; company?: string; answers: LearnAnswer[] }
export interface LearnResponse { ok: true; learned: number; overrides: number }

export interface SubmittedRequest {
  url: string; title: string; company: string; resumeUsed?: string; coverLetterUsed?: string;
  /** Every value sent, for the application's record. */
  answers?: { label: string; value: LearnValue }[];
}
export interface SubmittedResponse { ok: true; jobId: string; created: boolean; already: boolean }

export interface StatusResponse { ok: true; paused: boolean; profileComplete: boolean; hasResume: boolean }
