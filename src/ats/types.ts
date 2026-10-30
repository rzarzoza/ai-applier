import type { Frame, Page } from "playwright";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";

export type OpenResult = { ok: true } | { ok: false; reason: "closed" | "not-found" | "already-applied" | "blocked"; detail?: string };

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
  /**
   * Called once after the runner has filled the form's file fields (the resume first) and before it fills anything else:
   * waits for the site to finish handling the upload (e.g. a resume parser that autofills or clears fields), so the
   * runner's answers are typed after it, not overwritten by it. Must not throw on a timeout; omit when the site has none.
   */
  afterUpload?(page: Page): Promise<void>;
  /**
   * The option texts a select, combobox or radio group offers right now, read by opening the control (comboboxes with
   * their typed text cleared, so the whole list shows). `typed` is the value that did not match: when a list stays
   * empty until something is typed, its first letter is typed to load options. With `search`, the whole of `typed` is
   * typed (a search) and the options it surfaces are returned. Leaves the control closed and empty.
   * Omit to use the generic reader (forms/fill.ts `readOptions`).
   */
  readOptions?(page: Page, field: FieldSpec, typed?: string, search?: boolean): Promise<string[]>;
  readBack(page: Page, field: FieldSpec): Promise<string | string[] | boolean | null>;
  submit(page: Page): Promise<void>;
  outcome(page: Page): Promise<SubmitOutcome>;
  /** Job description text (trimmed, at most 8000 chars) when the page shows one. */
  description(page: Page): Promise<string | undefined>;
}
