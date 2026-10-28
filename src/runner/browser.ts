import { chromium, type Page } from "playwright";
import type { Resolution } from "../answers/resolve.js";
import type { AtsHandler } from "../ats/types.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import { paths } from "../paths.js";

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
  open(opts: { headless: boolean }): Promise<BrowserSession>;
  /**
   * True when the provider keeps pages for the dashboard's live view: runs it can show there never need a visible
   * window (only "Pop out" and "Do it now" ask for one).
   */
  readonly keepsPages?: boolean;
  /** Closes the page kept for the job, if any (a new run of the job replaces it). */
  unpark?(jobId: string): Promise<void>;
}

/** Chromium with a persistent profile at `BROWSER_PROFILE_DIR`, so cookies and portal sessions survive between runs. */
export const persistentChromium: BrowserProvider = {
  async open({ headless }) {
    const context = await chromium.launchPersistentContext(paths.browserProfile, { headless });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      return { page, close: () => context.close() };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  },
};
