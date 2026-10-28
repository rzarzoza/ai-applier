import { getSettings } from "../../settings.js";
import path from "node:path";
import { getOverrides } from "../../answers/bank.js";
import type { Resolution } from "../../answers/resolve.js";
import type { Db } from "../../db/db.js";
import type { FieldAnswer, FieldSpec } from "../../forms/types.js";
import { countByStatus, listJobs } from "../../jobs/repo.js";
import type { Job, JobStatus } from "../../jobs/types.js";
import { paths } from "../../paths.js";
import { getSnapshot } from "../../runner/records.js";
import { Layout } from "../layout.js";
import { inboxCount } from "./inbox.js";

export const PAGE_SIZE = 50;
export const UNKNOWN_SUBMISSION_PREFIX = "Submission state unknown";

const STATUSES: JobStatus[] = [
  "new", "queued", "filling", "needs-you", "ready-to-review", "submitted", "failed", "unsupported",
  "applied-manually", "skipped", "duplicate-role", "closed",
];
export const isStatus = (s: unknown): s is JobStatus => typeof s === "string" && (STATUSES as string[]).includes(s);

export const isUnknownSubmission = (j: Job) => j.status === "needs-you" && !!j.statusReason?.startsWith(UNKNOWN_SUBMISSION_PREFIX);
export const canRetry = (j: Job) => j.status === "failed" || j.status === "unsupported" || isUnknownSubmission(j);
export const canSkip = (j: Job) => ["new", "queued", "needs-you", "ready-to-review", "failed", "unsupported"].includes(j.status);
export const canMarkApplied = (j: Job) => !["submitted", "applied-manually", "filling"].includes(j.status);

const day = (d: Date) => d.toISOString().slice(0, 10);
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);
const recordUrl = (file: string) => "/records/" + path.relative(paths.records, file).split(path.sep).map(encodeURIComponent).join("/");

export function ApplicationsPage(props: { db: Db; status?: JobStatus; page: number }) {
  const { db, status } = props;
  const counts = countByStatus(db);
  const total = status ? counts[status] : Object.values(counts).reduce((a, b) => a + b, 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, props.page), pages);
  const jobs = listJobs(db, { status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const link = (p: number) => `/applications?${status ? `status=${status}&` : ""}page=${p}`;
  return (
    <Layout active="applications" inboxCount={inboxCount(db)} paused={getSettings(db).paused}>
      <h1>Applications</h1>
      <div class="row">
        <a href="/applications" class={status ? "" : "active"}>All <span class="badge">{Object.values(counts).reduce((a, b) => a + b, 0)}</span></a>
        {STATUSES.map(s => (
          <a href={`/applications?status=${s}`} class={s === status ? "active" : ""}>{s}<span class="badge">{counts[s]}</span></a>
        ))}
      </div>
      {jobs.length === 0 ? <p class="empty">No applications here yet.</p> : (
        <table>
          <tr><th>Company</th><th>Title</th><th>Location</th><th>Posted</th><th>ATS</th><th>Status</th><th>Reason</th></tr>
          {jobs.map(j => (
            <tr>
              <td><a href={`/applications/${j.id}`}>{j.company}</a></td>
              <td>{j.title}</td>
              <td>{j.chosenLocation ?? j.locations.join(", ")}</td>
              <td>{day(j.datePosted)}</td>
              <td>{j.ats ?? ""}</td>
              <td>{j.status}</td>
              <td>{j.statusReason ?? ""}</td>
            </tr>
          ))}
        </table>
      )}
      <div class="row">
        {page > 1 ? <a href={link(page - 1)}>Previous</a> : null}
        <span class="meta">Page {page} of {pages}</span>
        {page < pages ? <a href={link(page + 1)}>Next</a> : null}
      </div>
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
    return { field, answer: null, source: r?.status === "blocked" ? "needs an answer" : "left blank" };
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
    ? <div>{opts.map(o => <label class="meta"><input type="checkbox" name="value" value={o} checked={chosen.has(o)} /> {o}{" "}</label>)}</div>
    : opts && ["select", "combobox", "radio"].includes(field.kind)
      ? <select name="value">{opts.map(o => <option value={o} selected={o === text}>{o}</option>)}</select>
      : field.kind === "textarea" || text.length > 80
        ? <textarea name="value">{text}</textarea>
        : <input type="text" name="value" value={text} />;
  return (
    <div class="card">
      <strong>{field.label}</strong>{field.required ? " *" : ""}
      <div class="meta">{source}</div>
      {canEdit ? (
        <form method="post" action={`/applications/${props.jobId}/field`}>
          <input type="hidden" name="label" value={field.label} />
          {input}
          <div class="row">
            {fromBank ? <label class="meta"><input type="checkbox" name="saveToBank" value="1" /> Also save to my answer bank</label> : null}
            <button type="submit">Save</button>
          </div>
        </form>
      ) : <div class="draft">{text || "(blank)"}</div>}
    </div>
  );
}

function Action(props: { jobId: string; name: string; label: string; primary?: boolean; children?: unknown }) {
  return (
    <form method="post" action={`/applications/${props.jobId}/${props.name}`} class="row">
      {props.children as never}
      <button type="submit" class={props.primary ? "primary" : ""}>{props.label}</button>
    </form>
  );
}

export const NOTICES: Record<string, string> = {
  "bank-miss": "Saved for this job only — no matching answer-bank question",
};

export function JobDetailPage(props: { db: Db; job: Job; notice?: string }) {
  const { db, job } = props;
  const { views, screenshot } = fieldViews(db, job);
  const editable = job.status === "ready-to-review";
  const href = safeHref(job.url);
  return (
    <Layout active="applications" inboxCount={inboxCount(db)} paused={getSettings(db).paused}>
      <h1>{job.company} · {job.title}</h1>
      <div class="meta">
        {job.chosenLocation ?? job.locations.join(", ")} · posted {day(job.datePosted)} · {job.ats ?? "ATS unknown"} ·{" "}
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">View posting</a> : "no link"}
      </div>
      {props.notice && NOTICES[props.notice] ? <div class="note">{NOTICES[props.notice]}</div> : null}
      <p><strong>{job.status}</strong>{job.statusReason ? `: ${job.statusReason}` : ""}</p>
      {isUnknownSubmission(job) ? (
        <div class="note">This application may already have been sent — check your email or the company's site first.</div>
      ) : null}
      <div class="row">
        {editable ? <Action jobId={job.id} name="submit" label="Submit" primary /> : null}
        {canRetry(job) ? (
          <Action jobId={job.id} name="retry" label="Retry">
            {isUnknownSubmission(job) ? (
              <label class="meta"><input type="checkbox" name="confirm" value="1" required /> I checked, retry anyway</label>
            ) : null}
          </Action>
        ) : null}
        {canSkip(job) ? <Action jobId={job.id} name="skip" label="Skip" /> : null}
        {canMarkApplied(job) ? <Action jobId={job.id} name="mark-applied" label="Mark applied manually" /> : null}
      </div>
      {screenshot ? <p><img src={screenshot} alt="Screenshot of the application form" style="max-width:100%;border:1px solid var(--border)" /></p> : null}
      <h2>Fields</h2>
      {views.length === 0 ? <p class="empty">No fields were captured for this job yet.</p> : views.map(v => <FieldRow jobId={job.id} view={v} editable={editable} />)}
    </Layout>
  );
}
