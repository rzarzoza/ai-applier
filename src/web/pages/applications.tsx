import path from "node:path";
import { getOverrides } from "../../answers/bank.js";
import { canDoItNow, canHandFinish } from "../../answers/inbox.js";
import type { Resolution } from "../../answers/resolve.js";
import type { Db } from "../../db/db.js";
import type { FieldAnswer, FieldSpec } from "../../forms/types.js";
import { countByStatus, isUnknownSubmission, listJobs } from "../../jobs/repo.js";
import type { Job, JobStatus } from "../../jobs/types.js";
import { paths } from "../../paths.js";
import { getSnapshot } from "../../runner/records.js";
import { raw } from "hono/html";
import { Layout, pauseProps } from "../layout.js";
import { LIVE_CSS, LIVE_SCRIPT, LivePanel, type PanelState } from "../live.js";
import { Avatar, Chip, jobLocation, PageHead, shortDate, StatusChip, statusLabel } from "../ui.js";
import { inboxCount } from "./inbox.js";

export const PAGE_SIZE = 50;

const STATUSES: JobStatus[] = [
  "new", "queued", "filling", "needs-you", "ready-to-review", "submitted", "failed", "unsupported",
  "applied-manually", "skipped", "duplicate-role", "closed",
];
export const isStatus = (s: unknown): s is JobStatus => typeof s === "string" && (STATUSES as string[]).includes(s);

export { isUnknownSubmission };
export const canRetry = (j: Job) => j.status === "failed" || j.status === "unsupported" || isUnknownSubmission(j);
export const canSkip = (j: Job) => ["new", "queued", "needs-you", "ready-to-review", "failed", "unsupported"].includes(j.status);
export const canMarkApplied = (j: Job) => !["submitted", "applied-manually", "filling"].includes(j.status);

const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);
const recordUrl = (file: string) => "/records/" + path.relative(paths.records, file).split(path.sep).map(encodeURIComponent).join("/");

export function ApplicationsPage(props: { db: Db; status?: JobStatus; page: number }) {
  const { db, status } = props;
  const counts = countByStatus(db);
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const total = status ? counts[status] : all;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, props.page), pages);
  const jobs = listJobs(db, { status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const link = (p: number) => `/applications?${status ? `status=${status}&` : ""}page=${p}`;
  return (
    <Layout active="applications" inboxCount={inboxCount(db)} {...pauseProps(db)} title="Applications">
      <PageHead title="Applications" subtitle={`${all} ${all === 1 ? "posting" : "postings"} tracked`} />
      <nav class="pills" aria-label="Filter by status">
        <a href="/applications" class={status ? "" : "active"}>All <span class="count">{all}</span></a>
        {STATUSES.map(s => (
          <a href={`/applications?status=${s}`} class={s === status ? "active" : ""}>{statusLabel(s)}<span class="count">{counts[s]}</span></a>
        ))}
      </nav>
      <section class="card list-card">
        {jobs.length === 0 ? <p class="empty" style="padding:16px">No applications here yet.</p> : (
          <table>
            <thead>
              <tr><th>Job</th><th>Location</th><th>Posted</th><th>ATS</th><th>Status</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr>
                  <td>
                    <div class="job-cell">
                      <Avatar company={j.company} />
                      <div class="jrow-body">
                        <a class="jrow-title" href={`/applications/${j.id}`}>{j.title}</a>
                        <div class="jrow-sub">{j.company}</div>
                      </div>
                    </div>
                  </td>
                  <td class="jrow-meta">{jobLocation(j)}</td>
                  <td class="jrow-meta td-hide" style="white-space:nowrap">{shortDate(j.datePosted)}</td>
                  <td class="td-hide">{j.ats ? <Chip cls="chip-ats">{j.ats}</Chip> : ""}</td>
                  <td><StatusChip status={j.status} /></td>
                  <td class="reason">{j.statusReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {pages > 1 ? (
        <div class="pager">
          {page > 1 ? <a class="btn" href={link(page - 1)}>Previous</a> : null}
          <span class="meta">Page {page} of {pages}</span>
          {page < pages ? <a class="btn" href={link(page + 1)}>Next</a> : null}
        </div>
      ) : null}
    </Layout>
  );
}

export type FieldView = { field: FieldSpec; answer: FieldAnswer | null; source: string | null };

/** What the page shows for each snapshot field: the user's override if any, else what the runner resolved. */
export function fieldViews(db: Db, job: Job): { views: FieldView[]; screenshot: string | null } {
  const snap = getSnapshot(db, job.id);
  if (!snap) return { views: [], screenshot: null };
  const overrides = getOverrides(db, job.id);
  const byField = new Map<string, Resolution>(snap.resolutions.map(r => [r.fieldId, r]));
  const views = snap.fields.map((field): FieldView => {
    const override = overrides[field.label];
    if (override) return { field, answer: override, source: "override" };
    const r = byField.get(field.id);
    if (r?.status === "filled") return { field, answer: r.answer, source: r.source };
    return { field, answer: null, source: r?.status === "blocked" ? "needs an answer" : r?.status === "needs-file" ? "needs a file" : "left blank" };
  });
  return { views, screenshot: snap.screenshotPath ? recordUrl(snap.screenshotPath) : null };
}

export function answerText(a: FieldAnswer | null): string {
  if (!a) return "";
  switch (a.type) {
    case "text": return a.text;
    case "option": return a.option;
    case "options": return a.options.join(", ");
    case "check": return a.checked ? "yes" : "no";
    case "file": return a.path;
  }
}

/** Turns what the user typed into an answer of the type the field takes. */
export function parseAnswer(field: FieldSpec, current: FieldAnswer | null, input: string | string[]): FieldAnswer {
  const type = current?.type ?? (field.kind === "checkbox" ? "check" : field.kind === "checkbox-group" ? "options"
    : ["select", "combobox", "radio"].includes(field.kind) ? "option" : "text");
  const value = Array.isArray(input) ? input.join(", ") : input;
  switch (type) {
    case "check": return { type, checked: /^(yes|true|on|1)$/i.test(value.trim()) };
    case "options": return { type, options: Array.isArray(input) ? input : value.split(",").map(s => s.trim()).filter(Boolean) };
    case "option": return { type, option: value.trim() };
    default: return { type: "text", text: value };
  }
}

function FieldRow(props: { jobId: string; view: FieldView; editable: boolean }) {
  const { field, answer, source } = props.view;
  const text = answerText(answer);
  const canEdit = props.editable && field.kind !== "file" && answer?.type !== "file";
  const fromBank = source === "bank" && answer?.type === "text";
  const opts = field.options?.length ? field.options : null;
  const chosen = new Set(answer?.type === "options" ? answer.options : [text]);
  const input = opts && field.kind === "checkbox-group"
    ? <div>{opts.map(o => <label class="check"><input type="checkbox" name="value" value={o} checked={chosen.has(o)} /> {o}{" "}</label>)}</div>
    : opts && ["select", "combobox", "radio"].includes(field.kind)
      ? <select name="value">{opts.map(o => <option value={o} selected={o === text}>{o}</option>)}</select>
      : field.kind === "textarea" || text.length > 80
        ? <textarea name="value">{text}</textarea>
        : <input type="text" name="value" value={text} />;
  const missing = source === "needs an answer" || source === "needs a file";
  return (
    <div class="field-row">
      <div class="field-head">
        <span class="label">{field.label}{field.required ? <span class="req"> *</span> : ""}</span>
        <Chip cls={missing ? "chip-amber" : "chip-muted"}>{source}</Chip>
      </div>
      {canEdit ? (
        <form method="post" action={`/applications/${props.jobId}/field`}>
          <input type="hidden" name="label" value={field.label} />
          {input}
          <div class="row">
            {fromBank ? <label class="check" style="margin:0"><input type="checkbox" name="saveToBank" value="1" /> Also save to my answer bank</label> : null}
            <button type="submit" class="tertiary">Save</button>
          </div>
        </form>
      ) : <div class={text ? "value" : "value value-blank"}>{text || "(blank)"}</div>}
    </div>
  );
}

function Action(props: { jobId: string; name: string; label: string; primary?: boolean; tertiary?: boolean; children?: unknown }) {
  return (
    <form method="post" action={`/applications/${props.jobId}/${props.name}`}>
      {props.children as never}
      <button type="submit" class={props.primary ? "primary" : props.tertiary ? "tertiary" : ""}>{props.label}</button>
    </form>
  );
}

export const NOTICES: Record<string, string> = {
  "bank-miss": "Saved for this job only — no matching answer-bank question",
};

/**
 * The job's page. `live` is the Application panel's state when the job's form can be shown and finished right here (see
 * LivePanel); then Open & finish and Do it now become the panel's Pop out.
 */
export function JobDetailPage(props: { db: Db; job: Job; notice?: string; live?: PanelState }) {
  const { db, job, live } = props;
  const { views, screenshot } = fieldViews(db, job);
  const editable = job.status === "ready-to-review";
  const href = safeHref(job.url);
  const handFinish = !live && canHandFinish(db, job.id);
  const doItNow = !live && canDoItNow(db, job.id);
  return (
    <Layout active="applications" inboxCount={inboxCount(db)} {...pauseProps(db)} title={`${job.company} · ${job.title}`}>
      <p class="meta" style="margin:0 0 12px"><a href="/applications">← Applications</a></p>
      <section class="card">
        <div class="job-head">
          <Avatar company={job.company} size="lg" />
          <div class="job-head-body">
            <h1>{job.title}</h1>
            <div class="job-company">{job.company}</div>
            <div class="meta">
              {jobLocation(job)} · posted {shortDate(job.datePosted)} · {job.ats ?? "ATS unknown"} ·{" "}
              {href ? <a href={href} target="_blank" rel="noopener noreferrer">View posting</a> : "no link"}
            </div>
            <div class="row" style="margin-top:8px">
              <StatusChip status={job.status} />
              {job.statusReason ? <span class="meta">{job.statusReason}</span> : null}
            </div>
          </div>
        </div>
        {props.notice && NOTICES[props.notice] ? <div class="note">{NOTICES[props.notice]}</div> : null}
        {isUnknownSubmission(job) ? (
          <div class="note">This application may already have been sent — check your email or the company's site first.</div>
        ) : null}
        <div class="actions">
          {editable ? <Action jobId={job.id} name="submit" label="Submit" primary /> : null}
          {handFinish ? (
            <span id="hand-finish">
              <button class="primary" hx-post={`/applications/${job.id}/hand-finish`} hx-target="#hand-finish" hx-swap="innerHTML">Open &amp; finish</button>
            </span>
          ) : null}
          {doItNow ? (
            <span id="do-it-now">
              <button class="primary" hx-post={`/needs-you/${job.id}/do-it-now`} hx-target="#do-it-now" hx-swap="innerHTML">Do it now</button>
            </span>
          ) : null}
          {canRetry(job) ? (
            <Action jobId={job.id} name="retry" label="Retry">
              {isUnknownSubmission(job) ? (
                <label class="check" style="margin:0"><input type="checkbox" name="confirm" value="1" required /> I checked, retry anyway</label>
              ) : null}
            </Action>
          ) : null}
          {canMarkApplied(job) ? <Action jobId={job.id} name="mark-applied" label="Mark applied manually" /> : null}
          {canSkip(job) ? <Action jobId={job.id} name="skip" label="Skip" tertiary /> : null}
        </div>
        {handFinish ? (
          <p class="meta" style="margin-top:10px">
            Open &amp; finish opens the form in a browser window with everything the app knows filled in and the fields left for you
            highlighted. Complete them and press the site's own submit button; what you type is saved to your answer bank.
          </p>
        ) : null}
        {live ? (
          <p class="meta" style="margin-top:10px">
            Finish the application in the panel below: everything the app knows is filled in and the fields left for you are
            outlined. What you type is saved as you go, and once you press the site's own submit button it's recorded and your
            answers are saved to your answer bank. Pop out brings its tab to the front of the Chrome window instead.
          </p>
        ) : null}
      </section>
      {live ? (
        <>
          <style>{raw(LIVE_CSS)}</style>
          <LivePanel job={job} state={live} />
          <script>{raw(LIVE_SCRIPT)}</script>
        </>
      ) : null}
      {screenshot && !live ? (
        <section class="card">
          <div class="card-head"><h2>Last screenshot</h2></div>
          <img class="shot" src={screenshot} alt="Screenshot of the application form" />
        </section>
      ) : null}
      <section class="card list-card">
        <div class="card-head"><h2>Fields <span class="count">· {views.length}</span></h2></div>
        {views.length === 0 ? <p class="empty">No fields were captured for this job yet.</p> : views.map(v => <FieldRow jobId={job.id} view={v} editable={editable} />)}
      </section>
    </Layout>
  );
}
