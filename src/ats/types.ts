import type { Frame, Page } from "playwright";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";

export type OpenResult = { ok: true } | { ok: false; reason: "closed" | "not-found" | "already-applied"; detail?: string };

export type SubmitOutcome =
  | { kind: "submitted" }
  | { kind: "captcha" }
  | { kind: "verification-code" }
  | { kind: "validation-error"; messages: string[] }
  | { kind: "already-applied" }
  | { kind: "pending" }
  | { kind: "unknown"; detail: string };

/** One applicant-tracking system: how to reach its application form, read and fill it, submit, and judge the result. */
export interface AtsHandler {
  name: string;
  matches(url: string): boolean;
  /** Navigates to the posting and makes the application form reachable. */
  open(page: Page, url: string): Promise<OpenResult>;
  /** The document holding the form: an embedded frame or the page itself. */
  root(page: Page): Promise<Page | Frame>;
  readFields(page: Page): Promise<FieldSpec[]>;
  fill(page: Page, field: FieldSpec, answer: FieldAnswer): Promise<void>;
  readBack(page: Page, field: FieldSpec): Promise<string | string[] | boolean | null>;
  submit(page: Page): Promise<void>;
  outcome(page: Page): Promise<SubmitOutcome>;
  /** Job description text (trimmed, at most 8000 chars) when the page shows one. */
  description(page: Page): Promise<string | undefined>;
}
