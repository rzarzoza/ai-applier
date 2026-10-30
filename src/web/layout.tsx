import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { Db } from "../db/db.js";
import { formatUsd, spendToday, type Spend } from "../llm/meter.js";
import { budgetReached, claudeInUse } from "../llm/routed.js";
import { getRunnerHalt, getSettings } from "../settings.js";
import { Icon } from "./ui.js";

/**
 * The Layout's top-bar props: whether the runner is paused (and why if it paused itself), today's AI spend, and whether
 * today's Claude budget is spent (only when Claude is in use).
 */
export function pauseProps(db: Db): { paused: boolean; haltReason: string | null; aiSpend: Spend; budgetHit: boolean } {
  const s = getSettings(db);
  const paused = s.paused;
  return {
    paused, haltReason: paused ? getRunnerHalt(db)?.reason ?? null : null,
    aiSpend: spendToday(db), budgetHit: claudeInUse(s) && budgetReached(db),
  };
}

/** "AI spend today: $0.03 · 12 calls". */
export const spendLine = (s: Spend) => `AI spend today: ${formatUsd(s.costUsd)} · ${s.calls} ${s.calls === 1 ? "call" : "calls"}`;

const TABS: { href: string; label: string; key: string }[] = [
  { href: "/", label: "Home", key: "home" },
  { href: "/inbox", label: "Inbox", key: "inbox" },
  { href: "/applications", label: "Applications", key: "applications" },
  { href: "/bank", label: "Answer bank", key: "bank" },
  { href: "/profile", label: "Profile", key: "profile" },
  { href: "/sources", label: "Sources & filters", key: "sources" },
  { href: "/settings", label: "Settings", key: "settings" },
];

// Static stylesheet (no user text), so it is injected verbatim.
const CSS = `
:root {
  color-scheme: light;
  --bg: #f3f2ef; --card: #ffffff; --border: #e0dfdc; --text: #191919; --muted: #666666;
  --primary: #0a66c2; --primary-hover: #004182; --on-primary: #ffffff; --primary-tint: #e8f1fb;
  --success: #057642; --success-tint: #e5f2eb; --warning: #915907; --warning-tint: #fdf2dd; --danger: #cc1016; --danger-tint: #fcebec;
  --gray-chip: #ebebea; --gray-text: #404040; --hover: rgba(0, 0, 0, .05); --input-border: #a3a3a0; --field-bg: #ffffff;
  --nav-shadow: 0 1px 2px rgba(0, 0, 0, .08); --active: #191919; --focus: #0a66c2;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #000000; --card: #1b1f23; --border: #38434f; --text: #e9e5df; --muted: #a8b0b8;
    --primary: #70b5f9; --primary-hover: #a8d4ff; --on-primary: #0b1a29; --primary-tint: #1c2f43;
    --success: #6ccf96; --success-tint: #16301f; --warning: #f0b45c; --warning-tint: #3a2c12; --danger: #f6837a; --danger-tint: #3d1a1a;
    --gray-chip: #2c3238; --gray-text: #d0d4d8; --hover: rgba(255, 255, 255, .07); --input-border: #6b7580; --field-bg: #12161a;
    --nav-shadow: 0 1px 0 #38434f; --active: #e9e5df; --focus: #70b5f9;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #000000; --card: #1b1f23; --border: #38434f; --text: #e9e5df; --muted: #a8b0b8;
  --primary: #70b5f9; --primary-hover: #a8d4ff; --on-primary: #0b1a29; --primary-tint: #1c2f43;
  --success: #6ccf96; --success-tint: #16301f; --warning: #f0b45c; --warning-tint: #3a2c12; --danger: #f6837a; --danger-tint: #3d1a1a;
  --gray-chip: #2c3238; --gray-text: #d0d4d8; --hover: rgba(255, 255, 255, .07); --input-border: #6b7580; --field-bg: #12161a;
  --nav-shadow: 0 1px 0 #38434f; --active: #e9e5df; --focus: #70b5f9;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.45;
  font-family: -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.icon { display: block; flex: none; }

/* Top navigation */
.topnav { position: sticky; top: 0; z-index: 10; background: var(--card); box-shadow: var(--nav-shadow); }
.topnav-inner { max-width: 1128px; margin: 0 auto; padding: 0 24px; height: 52px; display: flex; align-items: center; gap: 16px; }
.brand { display: flex; align-items: center; gap: 8px; color: var(--text); font-weight: 600; font-size: 16px; white-space: nowrap; }
.brand:hover { text-decoration: none; }
.brand-mark { width: 30px; height: 30px; border-radius: 4px; background: #0a66c2; color: #fff; display: grid; place-items: center;
  font-weight: 700; font-size: 13px; letter-spacing: -.02em; }
.tabs { display: flex; margin-left: auto; height: 100%; }
.tab { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  min-width: 72px; padding: 0 10px; height: 100%; color: var(--muted); font-size: 12px; white-space: nowrap; }
.tab:hover { color: var(--text); text-decoration: none; }
.tab.active { color: var(--active); }
.tab.active::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--active); }
.tab-icon { position: relative; }
.run-toggle { display: flex; align-items: center; gap: 8px; margin: 0 0 0 4px; flex: none; }
.run-toggle button { padding: 3px 12px; font-size: 13px; }
.run-toggle button.resume { background: var(--warning); border-color: var(--warning); color: var(--card); }
.run-toggle button.resume:hover { box-shadow: none; filter: brightness(1.08); }
.nav-badge { position: absolute; top: -4px; right: -9px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #cc1016; color: #fff; font-size: 11px; font-weight: 600; line-height: 16px; text-align: center; box-shadow: 0 0 0 2px var(--card); }

/* Alert bars */
.alert { display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);
  border-left-width: 4px; background: var(--card); margin: 0 0 16px; font-size: 14px; }
.alert .icon { margin-top: 1px; }
.alert-warning { border-left-color: var(--warning); } .alert-warning .icon { color: var(--warning); }
.alert-success { border-left-color: var(--success); } .alert-success .icon { color: var(--success); }
.alert-danger { border-left-color: var(--danger); } .alert-danger .icon { color: var(--danger); }
.ai-strip { max-width: 1128px; margin: 0 auto; padding: 4px 24px 0; text-align: right; font-size: 12px; }
.ai-strip a { color: var(--muted); }
.alert-bar { background: var(--warning-tint); color: var(--text); border-bottom: 1px solid var(--border); }
.alert-bar-inner { max-width: 1128px; margin: 0 auto; padding: 10px 24px; display: flex; gap: 10px; align-items: center; }
.alert-bar .icon { color: var(--warning); }
.note { background: var(--warning-tint); color: var(--text); border-left: 4px solid var(--warning); border-radius: 4px; padding: 8px 12px; margin: 10px 0; font-size: 14px; }
.saved { color: var(--success); font-weight: 600; }
.card.saved { border-left: 4px solid var(--success); color: var(--text); font-weight: 400; }
.card.saved::before { content: "✓ "; color: var(--success); font-weight: 700; }

/* Page */
main { max-width: 1128px; margin: 0 auto; padding: 24px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin: 0 0 16px; }
h1 { font-size: 24px; font-weight: 600; margin: 0; line-height: 1.25; }
.subtitle { margin: 4px 0 0; color: var(--muted); }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
h3 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.section-title { font-size: 16px; font-weight: 600; margin: 28px 0 10px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; min-width: 0; }
.card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px 12px; margin-bottom: 8px; }
.card-head h2 { margin: 0; }
.card-head .count { color: var(--muted); font-weight: 400; }
.list-card { padding: 0; overflow: hidden; }
.list-card .card-head { padding: 16px 16px 4px; margin: 0; }
.list-card .card-foot { border-top: 1px solid var(--border); text-align: center; }
.list-card .card-foot a { display: block; padding: 10px; color: var(--muted); font-weight: 600; }
.list-card .card-foot a:hover { background: var(--hover); text-decoration: none; color: var(--text); }
.meta { color: var(--muted); font-size: 13px; margin: 2px 0; }
.empty { color: var(--muted); }
.list-card .empty { padding: 4px 16px 16px; margin: 0; }
.grid-2 { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.grid-2 > div { min-width: 0; }

/* Rows of jobs */
.jrow { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--border); }
.card-head + .jrow, .card-head + .jrows .jrow:first-child { border-top: 0; }
.jrow-body { flex: 1; min-width: 0; }
.jrow-title { font-weight: 600; color: var(--text); display: block; overflow-wrap: anywhere; }
.jrow-title:hover { color: var(--primary); }
.jrow-sub { color: var(--text); font-size: 14px; overflow-wrap: anywhere; }
.jrow-meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.jrow-reason { color: var(--warning); font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; }
.jrow-action { flex: none; display: flex; align-items: center; gap: 8px; }
.jrow-side { flex: none; color: var(--muted); font-size: 13px; text-align: right; }
.avatar { flex: none; width: 40px; height: 40px; border-radius: 6px; display: grid; place-items: center; color: #fff;
  font-weight: 600; font-size: 15px; letter-spacing: .02em; }
.compact .jrow { padding: 8px 16px; gap: 10px; align-items: flex-start; }
.compact .avatar { width: 32px; height: 32px; font-size: 12px; border-radius: 4px; margin-top: 2px; }
.compact .jrow-title { font-size: 14px; }
.compact .jrow-side { font-size: 12px; padding-top: 2px; }
.avatar-lg { width: 56px; height: 56px; font-size: 20px; border-radius: 8px; }

/* Chips */
.chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 11px; font-size: 12px;
  font-weight: 600; white-space: nowrap; border: 1px solid transparent; vertical-align: middle; }
.chip-blue { background: var(--primary); color: var(--on-primary); }
.chip-blue-outline { border-color: var(--primary); color: var(--primary); }
.chip-gray { background: var(--gray-chip); color: var(--gray-text); }
.chip-gray-outline { border-color: var(--input-border); color: var(--muted); }
.chip-amber { background: var(--warning-tint); color: var(--warning); }
.chip-green { background: var(--success-tint); color: var(--success); }
.chip-red { background: var(--danger-tint); color: var(--danger); }
.chip-muted { background: transparent; color: var(--muted); border-color: var(--border); }
.chip-ats { height: 20px; border-color: var(--border); color: var(--muted); font-weight: 500; text-transform: capitalize; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }

/* Buttons */
button, .btn { font: inherit; font-size: 14px; font-weight: 600; line-height: 20px; padding: 5px 16px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--primary); background: transparent; color: var(--primary); display: inline-flex; align-items: center; gap: 6px;
  white-space: nowrap; text-decoration: none; }
button:hover, .btn:hover { background: var(--primary-tint); box-shadow: inset 0 0 0 1px var(--primary); text-decoration: none; }
button.primary, .btn-primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
button.primary:hover, .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); box-shadow: none; }
button.tertiary, .btn-tertiary { border-color: transparent; color: var(--muted); padding: 5px 10px; }
button.tertiary:hover, .btn-tertiary:hover { background: var(--hover); box-shadow: none; color: var(--text); }
button.danger { border-color: var(--danger); color: var(--danger); }
button.danger:hover { background: var(--danger-tint); box-shadow: inset 0 0 0 1px var(--danger); }
button.copy { padding: 3px 12px; font-size: 13px; }
.working { color: var(--muted); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }

/* Forms */
textarea, select, input[type=text], input[type=password], input[type=search] { width: 100%; padding: 8px 10px; border: 1px solid var(--input-border);
  border-radius: 4px; background: var(--field-bg); color: var(--text); font: inherit; font-size: 14px; }
textarea:focus, select:focus, input:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 1px var(--focus); }
textarea { min-height: 90px; resize: vertical; }
input[type=file] { font: inherit; font-size: 13px; color: var(--muted); max-width: 100%; }
input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--primary); vertical-align: -3px; margin: 0 6px 0 0; }
.field { display: block; margin: 0 0 14px; font-size: 14px; color: var(--muted); }
.field > span:first-child { display: block; margin-bottom: 4px; color: var(--text); font-weight: 600; font-size: 13px; }
.field .hint { font-weight: 400; color: var(--muted); }
.check { display: flex; align-items: center; margin: 0 0 12px; color: var(--text); }
.fields-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.form-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
details { margin-top: 10px; } summary { cursor: pointer; color: var(--primary); font-weight: 600; }
.divider { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }

/* Inbox */
.draft { border-left: 3px solid var(--primary); padding: 6px 12px; margin: 10px 0; white-space: pre-wrap; background: var(--primary-tint); border-radius: 0 4px 4px 0; }
.blocked { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 10px; }
.quote-row { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0; }
blockquote.field-label { flex: 1; min-width: 0; margin: 0; padding: 6px 12px; border-left: 3px solid var(--input-border); background: var(--bg);
  border-radius: 0 4px 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Filter pills */
.pills { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 16px; }
.pills a { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--input-border);
  color: var(--muted); font-weight: 600; font-size: 13px; background: var(--card); }
.pills a:hover { text-decoration: none; background: var(--hover); color: var(--text); }
.pills a.active { background: var(--success); border-color: var(--success); color: var(--card); }
.pills .count { font-weight: 400; }

/* Tables */
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); padding: 10px 12px; border-bottom: 1px solid var(--border); }
td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
.job-cell { display: flex; gap: 12px; align-items: center; min-width: 220px; }
.reason { color: var(--muted); font-size: 13px; max-width: 260px; overflow-wrap: anywhere; }
.pager { display: flex; gap: 12px; align-items: center; justify-content: center; margin-top: 12px; }

/* Home */
.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; color: var(--text); display: block; }
.tile:hover { text-decoration: none; border-color: var(--primary); }
.tile-n { display: block; font-size: 24px; font-weight: 600; line-height: 1.2; }
.tile-label { display: block; color: var(--muted); font-size: 13px; }
.tile-warn .tile-n { color: var(--warning); }
.now { display: flex; gap: 16px; align-items: center; }
.now-body { flex: 1; min-width: 0; }
.now-title { font-size: 18px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.now-step { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--primary); font-weight: 600; }
.now-side { flex: none; text-align: right; color: var(--muted); font-size: 13px; }
.now-idle { display: flex; gap: 12px; align-items: center; color: var(--muted); }
.now-idle .icon { color: var(--muted); }
.progress { height: 4px; border-radius: 2px; background: var(--gray-chip); margin-top: 12px; overflow: hidden; }
.progress > span { display: block; height: 100%; background: var(--primary); border-radius: 2px; }

/* Job detail */
.job-head { display: flex; gap: 16px; align-items: flex-start; }
.job-head-body { flex: 1; min-width: 0; }
.job-head h1 { font-size: 22px; overflow-wrap: anywhere; }
.job-company { font-size: 16px; margin-top: 2px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
.actions form { display: inline-flex; gap: 8px; align-items: center; margin: 0; flex-wrap: wrap; }
.shot { display: block; max-width: 100%; border: 1px solid var(--border); border-radius: 4px; }
.field-row { padding: 14px 16px; border-top: 1px solid var(--border); }
.field-row:first-of-type { border-top: 0; }
.field-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }
.field-row .row { margin-top: 6px; }
.field-row .label { font-weight: 600; overflow-wrap: anywhere; }
.field-row .req { color: var(--danger); }
.value { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; }
.value-blank { color: var(--muted); font-style: italic; }

@media (max-width: 1000px) {
  .brand-name { display: none; }
  .tab { min-width: 0; padding: 0 8px; }
}
@media (max-width: 768px) {
  .topnav-inner { padding: 0 16px; gap: 8px; }
  .tabs { flex: 1; justify-content: space-between; }
  .tab { flex: 1; padding: 0; }
  .run-chip { display: none; }
  .tab-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  main { padding: 16px; }
  .alert-bar-inner { padding: 10px 16px; }
  .ai-strip { padding: 4px 16px 0; }
  .grid-2, .fields-grid { grid-template-columns: minmax(0, 1fr); }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tiles .tile:last-child { grid-column: span 2; }
  .jrow { flex-wrap: wrap; }
  .jrow-action { width: 100%; padding-left: 52px; }
  .jrow-action.plain { padding-left: 0; }
  .compact .jrow { flex-wrap: nowrap; }
  .compact .jrow-side { text-align: right; }
  .now { flex-wrap: wrap; }
  .now-side { text-align: left; width: 100%; }
  table, tbody, tr, td { display: block; width: 100%; }
  thead { display: none; }
  tr { border-bottom: 1px solid var(--border); padding: 10px 0; }
  tr:last-child { border-bottom: 0; }
  td { border: 0; padding: 2px 16px; }
  td + td { padding-left: 68px; }
  table.spend td + td { padding-left: 16px; }
  .job-cell { min-width: 0; }
  .reason { max-width: none; }
  .td-hide { display: none; }
}
`;

export function Layout(props: {
  active: string; inboxCount: number; paused?: boolean; haltReason?: string | null; title?: string; children?: Child;
  aiSpend?: Spend; budgetHit?: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title ? `${props.title} · AI Applier` : "AI Applier"}</title>
        <style>{raw(CSS)}</style>
        <script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
      </head>
      <body>
        <header class="topnav">
          <div class="topnav-inner">
            <a class="brand" href="/" aria-label="AI Applier home"><span class="brand-mark">AI</span><span class="brand-name">AI Applier</span></a>
            <nav class="tabs" aria-label="Main">
              {TABS.map(t => (
                <a href={t.href} class={t.key === props.active ? "tab active" : "tab"} aria-current={t.key === props.active ? "page" : undefined} title={t.label}>
                  <span class="tab-icon">
                    <Icon name={t.key} />
                    {t.key === "inbox" && props.inboxCount > 0 ? <span class="badge nav-badge">{props.inboxCount > 99 ? "99+" : props.inboxCount}</span> : null}
                  </span>
                  <span class="tab-label">{t.label}</span>
                </a>
              ))}
            </nav>
            <RunToggle paused={!!props.paused} />
          </div>
        </header>
        {props.paused ? (
          <div class="alert-bar" role="status">
            <div class="alert-bar-inner">
              <Icon name="alert" size={20} />
              <span>
                {props.haltReason
                  ? <>Paused: {props.haltReason}. Press Resume in the top bar once it's fixed.</>
                  : <>Paused — nothing will be applied. Press Resume in the top bar when your profile and resume are ready.</>}
              </span>
            </div>
          </div>
        ) : null}
        {props.budgetHit ? (
          <div class="alert-bar" role="status">
            <div class="alert-bar-inner">
              <Icon name="alert" size={20} />
              <span>AI budget reached for today — Claude is off until tomorrow, and the fields it would answer are left for you. Raise the budget in <a href="/settings#ai">Settings</a>.</span>
            </div>
          </div>
        ) : null}
        {props.aiSpend ? <div class="ai-strip"><a href="/settings#ai">{spendLine(props.aiSpend)}</a></div> : null}
        <main>{props.children}</main>
      </body>
    </html>
  );
}

/**
 * The runner's Pause / Resume pill in the top bar (every page). Pausing lets the job being filled finish its current
 * step, then stops it; resuming queues again any job a pause stopped. Posts to /runner/pause or /runner/resume.
 */
export function RunToggle(props: { paused: boolean }) {
  return (
    <form class="run-toggle" method="post" action={props.paused ? "/runner/resume" : "/runner/pause"}>
      {props.paused ? <span class="chip chip-amber run-chip">Paused</span> : null}
      {props.paused
        ? <button type="submit" class="resume" title="Start applying again">Resume</button>
        : <button type="submit" title="Stop applying: the current job finishes its current step, then stops">Pause</button>}
    </form>
  );
}

/** A LinkedIn-style alert box inside the page. */
export function Alert(props: { kind: "success" | "warning" | "danger"; children?: Child }) {
  return (
    <div class={`alert alert-${props.kind}`} role="status">
      <Icon name={props.kind === "success" ? "check" : "alert"} size={18} />
      <div>{props.children}</div>
    </div>
  );
}
