import type { Page } from "playwright";
import type { Resolution } from "../answers/resolve.js";
import type { AtsHandler } from "../ats/types.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";

/** A field of a parked page whose value the live view keeps an eye on (see LiveService). */
export interface WatchField {
  field: FieldSpec;
  /** The bank question the field answers, when the run found it blocked on one. */
  questionId: number | null;
  /** What the app filled in, or null when it left the field for the user. */
  filled: FieldAnswer | null;
}

/** What a run knew about the page it parks: enough to watch it, refill it, and record a submission made on it. */
export interface ParkInfo {
  handler: AtsHandler;
  fields: FieldSpec[];
  resolutions: Resolution[];
  watch: WatchField[];
  notes: string[];
}

export interface BrowserSession {
  page: Page;
  close(): Promise<void>;
  /**
   * Hands the page over to the provider, which keeps it open for the dashboard's live view instead of closing it.
   * Returns false when it cannot keep it (the caller then closes it). Absent when the provider never keeps pages.
   */
  park?(jobId: string, info: ParkInfo): boolean;
}

export interface BrowserProvider {
  /** A page (tab) for one run. With `front`, it is brought to the front of the window: the user is about to use it. */
  open(opts?: { front?: boolean }): Promise<BrowserSession>;
  /**
   * True when the provider keeps pages for the dashboard's live view: a run that needs the user (a CAPTCHA, a code) hands
   * its page over right away instead of waiting for them.
   */
  readonly keepsPages?: boolean;
  /** Closes the page kept for the job, if any (a new run of the job replaces it). */
  unpark?(jobId: string): Promise<void>;
}
