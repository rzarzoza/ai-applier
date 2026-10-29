/** Where the extension wakes up by itself, and which part of a page is the application form. */
import { deepQueryAll, lightHost } from "./dom.js";

/**
 * Pages of the application systems the extension fills on its own (any other page only on "Fill this page"):
 * Greenhouse (boards and embeds), Lever, Ashby, Workday, Oracle Cloud's candidate experience, SmartRecruiters, iCIMS,
 * BambooHR careers and Workable. A company page embedding a Greenhouse form (?gh_jid=) counts too.
 */
export function isApplicationPage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const p = url.pathname;
  return host === "greenhouse.io" || host.endsWith(".greenhouse.io")
    || host === "jobs.lever.co"
    || host === "jobs.ashbyhq.com"
    || host.endsWith(".myworkdayjobs.com")
    || (host.endsWith(".oraclecloud.com") && /\/hcmUI\/CandidateExperience/i.test(p))
    || host === "jobs.smartrecruiters.com"
    || host.endsWith(".icims.com")
    || (host.endsWith(".bamboohr.com") && /^\/careers/i.test(p))
    || host === "apply.workable.com"
    || url.searchParams.has("gh_jid");
}

/** Controls that count toward "a form worth filling". */
const CONTROL = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=password]), select, textarea, [role=combobox]";

const visible = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0;

/**
 * How many visible controls the element holds, open shadow roots included (a hidden file input counts: uploads hide
 * theirs behind a button).
 */
export function controlCount(root: Element): number {
  let n = 0;
  deepQueryAll(root, CONTROL).forEach(e => {
    if (e.closest("#ai-applier-panel-host, [aria-hidden=true]") || inPageChrome(e)) return;
    if (visible(e) || (e instanceof HTMLInputElement && e.type === "file")) n++;
  });
  return n;
}

/** Regions of a page that are never the application (site search, navigation, cookie banners, footers). */
const NOT_THE_FORM = "header, nav, footer, [role=search], [role=navigation], [role=banner], [id*=cookie i], [class*=cookie i]";

/** Whether a control sits in the page's header, navigation, footer, search or cookie banner (inside a shadow root too). */
export function inPageChrome(e: Element): boolean {
  return !!e.closest(NOT_THE_FORM) || !!lightHost(e).closest(NOT_THE_FORM);
}

/**
 * The application form: the visible <form> with the most controls (at least `min`). A page with no such form (single-
 * page apps often have none, and web-component forms keep their fields in shadow roots) falls back, when `allowBody`,
 * to the smallest block holding all of the page's controls. A form inside a shadow root stands as its light-DOM host.
 */
export function findFormScope(min: number, allowBody: boolean): Element | null {
  const forms = deepQueryAll<HTMLFormElement>(document, "form")
    .filter(f => !f.closest(NOT_THE_FORM) && !f.closest("#ai-applier-panel-host") && visible(f) && !f.matches("[role=search]"))
    .map(f => ({ f, n: controlCount(f) }))
    .filter(x => x.n >= min && !hasPassword(x.f))
    .sort((a, b) => b.n - a.n);
  if (forms.length) return lightHost(forms[0]!.f);
  if (!allowBody) return null;
  const main = document.querySelector("main, [role=main]") ?? document.body;
  const total = controlCount(main);
  if (total < min) return null;
  // Walk down while one child still holds every control: the tightest block around the form.
  let scope: Element = main;
  for (;;) {
    const next = Array.from(scope.children).find(ch => !ch.matches(NOT_THE_FORM) && controlCount(ch) === total);
    if (!next) break;
    scope = next;
  }
  return hasPassword(scope) ? null : scope;
}

/** A form asking for a password is a sign-in or sign-up form, not an application: it's left alone. */
function hasPassword(root: Element): boolean {
  return deepQueryAll(root, "input[type=password]").length > 0;
}

/** Marks the scope so collectFields can find it by selector. */
export const SCOPE_ATTR = "data-aa-scope";
export function markScope(el: Element): string {
  document.querySelectorAll(`[${SCOPE_ATTR}]`).forEach(e => { if (e !== el) e.removeAttribute(SCOPE_ATTR); });
  el.setAttribute(SCOPE_ATTR, "");
  return `[${SCOPE_ATTR}]`;
}

/** The job's title and company as the page states them, best effort (the app uses its job row when it has one). */
export function pageJob(): { title: string; company?: string } {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const docTitle = squash(document.title);
  const gh = /^Job Application for (.+?) at (.+)$/i.exec(docTitle);
  if (gh) return { title: gh[1]!, company: gh[2]! };
  const lever = /^(.+?) - (.+)$/.exec(docTitle);
  const h1 = squash(document.querySelector("h1")?.textContent);
  const site = squash(document.querySelector<HTMLMetaElement>("meta[property='og:site_name']")?.content);
  if (lever && location.hostname === "jobs.lever.co") return { title: lever[2]!, company: lever[1]! };
  return { title: h1 || docTitle, ...(site ? { company: site } : {}) };
}
