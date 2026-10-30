import type { Db } from "../../db/db.js";
import { DEFAULT_FILTERS, evaluateFilters, getFilters, type FilterRules } from "../../filters/filters.js";
import { getJson } from "../../settings.js";
import type { PollReport } from "../../sources/poller.js";
import { listJobs } from "../../jobs/repo.js";
import { listSources } from "../../sources/repo.js";
import type { Posting } from "../../sources/types.js";
import { Alert, Layout, pauseProps } from "../layout.js";
import { Chip, PageHead } from "../ui.js";
import { inboxCount } from "./inbox.js";

const LIST_KEYS = ["categories", "includeCountries", "excludeCountries", "includeLocations", "excludeLocations", "excludeCompanies", "titleRequire", "titleBlock", "degrees"] as const;

const LABELS: Record<(typeof LIST_KEYS)[number], string> = {
  categories: "Categories", includeCountries: "Only these countries", excludeCountries: "Exclude countries",
  includeLocations: "Only these locations", excludeLocations: "Exclude locations", excludeCompanies: "Exclude companies",
  titleRequire: "Title must contain one of", titleBlock: "Title must not contain", degrees: "Degrees",
};

const splitList = (v: unknown): string[] =>
  typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean) : [];

/** Reads the filter form (or the preview's query string) into rules; missing fields fall back to the defaults. */
export function parseFilterForm(form: Record<string, unknown>): FilterRules {
  const rules: FilterRules = { ...DEFAULT_FILTERS };
  for (const k of LIST_KEYS) if (k in form) rules[k] = splitList(form[k]);
  rules.locationMode = form.locationMode === "all" ? "all" : "any";
  const days = typeof form.postedWithinDays === "string" ? Number(form.postedWithinDays.trim()) : NaN;
  rules.postedWithinDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : null;
  return rules;
}

/** "N of M current postings match" over every job's stored posting. */
export function previewCount(db: Db, rules: FilterRules, now: Date): { matching: number; total: number } {
  const jobs = listJobs(db, {});
  let matching = 0;
  for (const j of jobs) {
    const posting: Posting = {
      sourceId: j.sourceId, listingId: j.listingId, company: j.company, title: j.title, locations: j.locations, category: j.category,
      terms: j.terms, degrees: [], sponsorship: null, url: j.url, datePosted: j.datePosted, active: j.active,
    };
    if (evaluateFilters(posting, rules, now).pass) matching++;
  }
  return { matching, total: jobs.length };
}

export function PreviewFragment(props: { matching: number; total: number }) {
  return <span>{props.matching} of {props.total} current postings match</span>;
}

export function SourcesPage(props: { db: Db; notice?: string; error?: string }) {
  const sources = listSources(props.db);
  const rules = getFilters(props.db);
  const now = new Date();
  const reports = getJson<Record<string, { at: string; report: PollReport }>>(props.db, "pollReports", {});
  const preview = previewCount(props.db, rules, now);
  return (
    <Layout active="sources" inboxCount={inboxCount(props.db)} {...pauseProps(props.db)} title="Sources & filters">
      <PageHead title="Sources & filters" subtitle="Where postings come from, and which ones are worth applying to."
        actions={<form method="post" action="/sources/poll"><button type="submit">Poll now</button></form>} />
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {props.error ? <Alert kind="danger">{props.error}</Alert> : null}
      <section class="card list-card">
        <div class="card-head"><h2>Sources <span class="count">· {sources.length}</span></h2></div>
        {sources.length === 0 ? <p class="empty">No sources yet. Add a GitHub repo below.</p> : sources.map(s => {
          const r = reports[s.id]?.report;
          return (
            <div class="jrow">
              <div class="jrow-body">
                <div><strong style="overflow-wrap:anywhere">{s.id}</strong> <Chip cls="chip-muted">{s.kind}</Chip> <Chip cls={s.enabled ? "chip-green" : "chip-muted"}>{s.enabled ? "Enabled" : "Disabled"}</Chip></div>
                <div class="jrow-meta">{s.url}</div>
                <div class="jrow-meta">Last polled: {s.lastPolledAt ?? "not polled yet"}</div>
                {r ? (
                  r.error
                    ? <div class="jrow-reason" style="color:var(--danger)">Last error: {r.error}</div>
                    : <div class="jrow-meta">OK: {r.fetched} fetched, {r.newJobs} new, {r.queued} queued, {r.skipped} skipped</div>
                ) : null}
              </div>
              <form method="post" action={`/sources/${s.id}/toggle`} class="jrow-action plain">
                <input type="hidden" name="enabled" value={s.enabled ? "0" : "1"} />
                <button type="submit" class={s.enabled ? "tertiary" : ""}>{s.enabled ? "Disable" : "Enable"}</button>
              </form>
            </div>
          );
        })}
      </section>
      <section class="card">
        <div class="card-head"><h2>Add a GitHub source</h2></div>
        <form method="post" action="/sources" class="row" style="margin-top:0;flex-wrap:nowrap">
          <input type="text" name="url" placeholder="https://github.com/owner/repo or a listings.json URL" aria-label="Source URL" required />
          <button class="primary" type="submit">Add source</button>
        </form>
      </section>
      <form method="post" action="/filters" class="card" hx-get="/filters/preview" hx-trigger="input changed delay:300ms" hx-target="#preview">
        <div class="card-head"><h2>Filters</h2><span class="meta" id="preview"><PreviewFragment {...preview} /></span></div>
        <div class="fields-grid">
          {LIST_KEYS.map(k => (
            <label class="field">
              <span>{LABELS[k]} <span class="hint">(comma-separated)</span></span>
              <input type="text" name={k} value={rules[k].join(", ")} />
            </label>
          ))}
          <label class="field">
            <span>Location mode</span>
            <select name="locationMode">
              <option value="any" selected={rules.locationMode === "any"}>Any location may match</option>
              <option value="all" selected={rules.locationMode === "all"}>Every location must match</option>
            </select>
          </label>
          <label class="field">
            <span>Posted within <span class="hint">(days, blank for any)</span></span>
            <input type="text" name="postedWithinDays" value={rules.postedWithinDays === null ? "" : String(rules.postedWithinDays)} />
          </label>
        </div>
        <div class="form-foot"><button class="primary" type="submit">Save filters</button></div>
      </form>
    </Layout>
  );
}
