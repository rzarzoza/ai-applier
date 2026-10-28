import { canDoItNow, canHandFinish, profileSuggestions } from "../../answers/inbox.js";
import type { Db } from "../../db/db.js";
import { countByStatus, getJob, isUnknownSubmission, recentWithStatus, upNext } from "../../jobs/repo.js";
import type { Job, JobStatus } from "../../jobs/types.js";
import { getRunnerCurrent, STEPS, type RunnerCurrent } from "../../runner/current.js";
import { getSettings } from "../../settings.js";
import { Layout, pauseProps } from "../layout.js";
import { ago, Avatar, Chip, elapsed, Icon, jobLocation, PageHead, shortDate } from "../ui.js";
import { ApproveSuggestionsButton, inboxCount } from "./inbox.js";

const UP_NEXT = 15;
const RECENT = 10;
const LIST_MAX = 20;

/** What the dashboard needs to know beyond the database: jobs the user asked to run that haven't started yet. */
export interface HomeProps { db: Db; requested?: readonly string[]; now?: Date }

const TILES: { status: JobStatus; label: string; warn?: true }[] = [
  { status: "queued", label: "Queued" },
  { status: "needs-you", label: "Needs your input", warn: true },
  { status: "ready-to-review", label: "Ready to review" },
  { status: "submitted", label: "Submitted" },
  { status: "unsupported", label: "Unsupported" },
];

/** The job being processed right now, its step and how long it has been running; idle or paused otherwise. */
export function NowCard(props: HomeProps) {
  const { db } = props;
  const now = props.now ?? new Date();
  const current = getRunnerCurrent(db);
  const job = current ? getJob(db, current.jobId) : null;
  const refresh = { id: "now", "hx-get": "/home/now", "hx-trigger": "every 3s", "hx-swap": "outerHTML" };
  if (current && job) return <NowRunning current={current} job={job} now={now} refresh={refresh} />;
  const paused = getSettings(db).paused;
  const queued = countByStatus(db).queued;
  return (
    <section class="card" {...refresh} aria-live="polite">
      <div class="card-head"><h2>Applying now</h2></div>
      <div class="now-idle">
        <Icon name={paused ? "alert" : "applications"} />
        <div>
          {paused
            ? <><strong>Paused</strong> — no new applications start until you turn it off in <a href="/settings">Settings</a>.</>
            : queued > 0 ? <>Idle — next job starts shortly.</> : <>Idle — nothing is queued right now.</>}
        </div>
      </div>
    </section>
  );
}

function NowRunning(props: { current: RunnerCurrent; job: Job; now: Date; refresh: Record<string, string> }) {
  const { current, job } = props;
  const started = new Date(current.startedAt);
  const ms = Number.isNaN(started.getTime()) ? 0 : props.now.getTime() - started.getTime();
  const i = STEPS.indexOf(current.step);
  const pct = i < 0 ? 10 : Math.round(((i + 1) / STEPS.length) * 100);
  return (
    <section class="card" {...props.refresh} aria-live="polite">
      <div class="card-head">
        <h2>Applying now</h2>
        <Chip cls="chip-blue"><span class="live-dot"></span>Live</Chip>
      </div>
      <div class="now">
        <Avatar company={job.company} size="lg" />
        <div class="now-body">
          <a class="now-title" href={`/applications/${job.id}`}>{job.title}</a>
          <div class="jrow-sub">{job.company}</div>
          <div class="jrow-meta">{jobLocation(job)} {job.ats ? <Chip cls="chip-ats">{job.ats}</Chip> : null}</div>
          <div class="now-step"><span class="live-dot"></span>{current.step}</div>
        </div>
        <div class="now-side">Started {elapsed(ms)} ago</div>
      </div>
      <div class="progress" aria-hidden="true"><span style={`width:${pct}%`}></span></div>
    </section>
  );
}

function Tiles(props: { db: Db }) {
  const counts = countByStatus(props.db);
  return (
    <div class="tiles">
      {TILES.map(t => (
        <a class={`tile${t.warn && counts[t.status] > 0 ? " tile-warn" : ""}`} href={`/applications?status=${t.status}`}>
          <span class="tile-n">{counts[t.status]}</span>
          <span class="tile-label">{t.label}</span>
        </a>
      ))}
    </div>
  );
}

function JobLine(props: { job: Job; compact?: boolean; children?: unknown }) {
  const { job } = props;
  return (
    <div class="jrow-body">
      <a class="jrow-title" href={`/applications/${job.id}`}>{job.title}</a>
      {props.compact
        ? <div class="jrow-meta">{job.company} · {jobLocation(job)}</div>
        : <><div class="jrow-sub">{job.company}</div><div class="jrow-meta">{jobLocation(job)}</div></>}
      {props.children as never}
    </div>
  );
}

/** What a needs-you row offers: finish it by hand, clear a CAPTCHA/code/login, or check a possibly sent application. */
function NeedsAction(props: { db: Db; job: Job; running: boolean; requested: boolean }) {
  const { db, job } = props;
  if (props.running) return <Chip cls="chip-blue"><span class="live-dot"></span>Applying now</Chip>;
  if (props.requested) return <span class="working">Opening the application in a browser window…</span>;
  if (canHandFinish(db, job.id))
    return <button class="primary" hx-post={`/applications/${job.id}/hand-finish`} hx-target="this" hx-swap="outerHTML">Open &amp; finish</button>;
  if (canDoItNow(db, job.id))
    return <button class="primary" hx-post={`/needs-you/${job.id}/do-it-now`} hx-target="this" hx-swap="outerHTML">Do it now</button>;
  return <a class="btn" href={`/applications/${job.id}`}>{isUnknownSubmission(job) ? "Check" : "Open"}</a>;
}

function ListCard(props: {
  title: string; count: number; empty: string; compact?: boolean; footer?: { href: string; label: string }; action?: unknown; children?: unknown;
}) {
  const items = props.children as unknown[];
  return (
    <section class={`card list-card${props.compact ? " compact" : ""}`}>
      <div class="card-head"><h2>{props.title} <span class="count">· {props.count}</span></h2>{(props.action ?? null) as never}</div>
      {props.count === 0 ? <p class="empty">{props.empty}</p> : <div class="jrows">{items as never}</div>}
      {props.footer && props.count > 0 ? <div class="card-foot"><a href={props.footer.href}>{props.footer.label}</a></div> : null}
    </section>
  );
}

/** The stat tiles and the four lists, refreshed together every 10 seconds. */
export function HomeLists(props: HomeProps) {
  const { db } = props;
  const now = props.now ?? new Date();
  const counts = countByStatus(db);
  const current = getRunnerCurrent(db);
  const requested = new Set(props.requested ?? []);
  // A job the user is finishing at the browser is no longer "needs-you" while its window is open: keep it on top of its list.
  const atBrowser = current && (current.mode === "hand-finish" || current.mode === "interactive") ? getJob(db, current.jobId) : null;
  const needs = recentWithStatus(db, "needs-you", LIST_MAX);
  const needsRows = atBrowser?.status === "filling" ? [atBrowser, ...needs.filter(j => j.id !== atBrowser.id)] : needs;
  const review = recentWithStatus(db, "ready-to-review", LIST_MAX);
  const next = upNext(db, UP_NEXT);
  const recent = recentWithStatus(db, "submitted", RECENT);
  return (
    <div id="home-lists" hx-get="/home/lists" hx-trigger="every 10s" hx-swap="outerHTML">
      <Tiles db={db} />
      <div class="grid-2">
        <div>
          <ListCard title="Needs your input" count={counts["needs-you"] + (needsRows.length > needs.length ? 1 : 0)}
            action={<ApproveSuggestionsButton count={profileSuggestions(db).length} />}
            empty="Nothing needs you right now." footer={counts["needs-you"] > LIST_MAX ? { href: "/applications?status=needs-you", label: "View all" } : undefined}>
            {needsRows.map(j => (
              <div class="jrow" id={`needs-row-${j.id}`}>
                <Avatar company={j.company} />
                <JobLine job={j}>{j.statusReason ? <div class="jrow-reason">{j.statusReason}</div> : null}</JobLine>
                <div class="jrow-action">
                  <NeedsAction db={db} job={j} running={current?.jobId === j.id} requested={requested.has(j.id)} />
                </div>
              </div>
            ))}
          </ListCard>
          <ListCard title="Ready to review" count={counts["ready-to-review"]} empty="No applications are waiting for your review."
            footer={counts["ready-to-review"] > LIST_MAX ? { href: "/applications?status=ready-to-review", label: "View all" } : undefined}>
            {review.map(j => (
              <div class="jrow">
                <Avatar company={j.company} />
                <JobLine job={j} />
                <div class="jrow-action"><a class="btn" href={`/applications/${j.id}`}>Review</a></div>
              </div>
            ))}
          </ListCard>
        </div>
        <div>
          <ListCard title="Up next" count={counts.queued} compact empty="The queue is empty."
            footer={{ href: "/applications?status=queued", label: "View all" }}>
            {next.map(j => (
              <div class="jrow">
                <Avatar company={j.company} />
                <JobLine job={j} compact />
                <div class="jrow-side">{ago(j.datePosted, now)}</div>
              </div>
            ))}
          </ListCard>
          <ListCard title="Recently submitted" count={recent.length} compact empty="Nothing submitted yet."
            footer={{ href: "/applications?status=submitted", label: "View all" }}>
            {recent.map(j => (
              <div class="jrow">
                <Avatar company={j.company} />
                <JobLine job={j} compact />
                <div class="jrow-side">{j.submittedAt ? shortDate(j.submittedAt) : ""}</div>
              </div>
            ))}
          </ListCard>
        </div>
      </div>
    </div>
  );
}

export function HomePage(props: HomeProps) {
  const { db } = props;
  return (
    <Layout active="home" inboxCount={inboxCount(db)} {...pauseProps(db)} title="Home">
      <PageHead title="Home" subtitle="What the applier is doing, and what's waiting on you." />
      <NowCard {...props} />
      <HomeLists {...props} />
    </Layout>
  );
}
