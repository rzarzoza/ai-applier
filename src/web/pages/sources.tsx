import type { Db } from "../../db/db.js";
import { DEFAULT_FILTERS, evaluateFilters, getFilters, type FilterRules } from "../../filters/filters.js";
import { getJson } from "../../settings.js";
import type { PollReport } from "../../sources/poller.js";
import { listJobs } from "../../jobs/repo.js";
import { listSources } from "../../sources/repo.js";
import type { Posting } from "../../sources/types.js";
import { Layout, pauseProps } from "../layout.js";
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
    <Layout active="sources" inboxCount={inboxCount(props.db)} {...pauseProps(props.db)}>
      <h1>Sources &amp; filters</h1>
      {props.notice ? <div class="card saved">{props.notice}</div> : null}
      {props.error ? <div class="note">{props.error}</div> : null}
      <h2>Sources</h2>
      {sources.map(s => (
        <div class="card">
          <strong>{s.id}</strong> <span class="meta">({s.kind})</span>
          <div class="meta">{s.url}</div>
          <div class="meta">Last polled: {s.lastPolledAt ?? "not polled yet"}</div>
          {reports[s.id] ? (
            reports[s.id]!.report.error
              ? <div class="note">Last error: {reports[s.id]!.report.error}</div>
              : <div class="meta">OK: {reports[s.id]!.report.fetched} fetched, {reports[s.id]!.report.newJobs} new, {reports[s.id]!.report.queued} queued, {reports[s.id]!.report.skipped} skipped</div>
          ) : null}
          <form method="post" action={`/sources/${s.id}/toggle`} class="row">
            <input type="hidden" name="enabled" value={s.enabled ? "0" : "1"} />
            <button type="submit">{s.enabled ? "Disable" : "Enable"}</button>
            <span class="meta">{s.enabled ? "Enabled" : "Disabled"}</span>
          </form>
        </div>
      ))}
      <form method="post" action="/sources/poll" class="row"><button type="submit">Poll now</button></form>
      <div class="card">
        <h3>Add a GitHub source</h3>
        <form method="post" action="/sources">
          <input type="text" name="url" placeholder="https://github.com/owner/repo or a listings.json URL" required />
          <div class="row"><button class="primary" type="submit">Add source</button></div>
        </form>
      </div>
      <h2>Filters</h2>
      <form method="post" action="/filters" class="card" hx-get="/filters/preview" hx-trigger="input changed delay:300ms" hx-target="#preview">
        {LIST_KEYS.map(k => (
          <label class="meta" style="display:block;margin:8px 0">
            {LABELS[k]} (comma-separated)
            <input type="text" name={k} value={rules[k].join(", ")} />
          </label>
        ))}
        <label class="meta" style="display:block;margin:8px 0">
          Location mode
          <select name="locationMode">
            <option value="any" selected={rules.locationMode === "any"}>Any location may match</option>
            <option value="all" selected={rules.locationMode === "all"}>Every location must match</option>
          </select>
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          Posted within (days, blank for any)
          <input type="text" name="postedWithinDays" value={rules.postedWithinDays === null ? "" : String(rules.postedWithinDays)} />
        </label>
        <div class="meta" id="preview"><PreviewFragment {...preview} /></div>
        <div class="row"><button class="primary" type="submit">Save filters</button></div>
      </form>
    </Layout>
  );
}
