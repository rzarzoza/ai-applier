/**
 * Resume parsers that rewrite the form after an upload (as the runner's afterUpload waits for them):
 * - Lever: `.resume-upload-working` ("Analyzing resume...") shows while it runs, then it writes what it parsed.
 * - Ashby: `.ashby-application-form-autofill-input-pending-layer` ("Parsing your resume. Autofilling key fields...")
 *   leaves `data-state="hidden"` while it runs; a `[role=progressbar]` spinner shows while a file uploads.
 * Nothing is filled while one is showing, or it would be overwritten.
 */
import { deepQueryAll } from "./dom.js";
import { isVisible, sleep } from "./widgets.js";

const INDICATORS = '.resume-upload-working, [class*="autofill-input-pending-layer"], [role=progressbar][aria-label*="loading" i]';
/** Longest wait for a parser to finish. */
const PARSE_WAIT_MS = 30_000;
/** How long a parser that exists on the page gets to start after an upload. */
const PARSE_START_MS = 3_000;

const showing = (e: Element) => e.getAttribute("data-state") !== "hidden" && isVisible(e);

/** The parse indicators on the page (in the form, or anywhere when it renders them elsewhere). */
function indicators(scope: Element | null): Element[] {
  const inScope = scope ? deepQueryAll(scope, INDICATORS) : [];
  return inScope.length ? inScope : deepQueryAll(document, INDICATORS).filter(e => !e.closest("#ai-applier-panel-host"));
}

/** Whether a resume parser (or an upload spinner) is showing now. */
export function parsing(scope: Element | null): boolean {
  return indicators(scope).some(showing);
}

/**
 * Waits for a parser to finish. After an upload (`afterUpload`), a parser the page has (its indicator exists, hidden)
 * first gets a moment to start; a page with none only gets a short beat.
 */
export async function waitForParse(scope: Element | null, afterUpload: boolean): Promise<void> {
  const end = Date.now() + PARSE_WAIT_MS;
  if (afterUpload) {
    await sleep(300);
    if (indicators(scope).length) {
      const startBy = Date.now() + PARSE_START_MS;
      while (!parsing(scope) && Date.now() < startBy) await sleep(100);
    }
  }
  while (parsing(scope) && Date.now() < end) await sleep(200);
  // The page writes the parse result right after hiding the indicator.
  if (afterUpload) await sleep(500);
}
