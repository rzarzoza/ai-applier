import { raw } from "hono/html";
import type { Child } from "hono/jsx";

const TABS: { href: string; label: string; key: string }[] = [
  { href: "/inbox", label: "Inbox", key: "inbox" },
  { href: "/applications", label: "Applications", key: "applications" },
  { href: "/answers", label: "Answer bank", key: "answers" },
  { href: "/profile", label: "Profile & resume", key: "profile" },
  { href: "/sources", label: "Sources & filters", key: "sources" },
  { href: "/settings", label: "Settings", key: "settings" },
];

// Static stylesheet (no user text), so it is injected verbatim.
const CSS = `
:root {
  --bg: #f6f7f9; --surface: #ffffff; --text: #1b1f24; --muted: #5d6671; --border: #d9dde3;
  --accent: #2f5fd0; --accent-text: #ffffff; --warn-bg: #fff4d6; --warn-text: #6b4b00; --ok: #1f7a3d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --surface: #1d2127; --text: #e6e9ed; --muted: #9aa4af; --border: #323943;
    --accent: #6b93f0; --accent-text: #10151c; --warn-bg: #3a2f10; --warn-text: #f2d48a; --ok: #5fcf85;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
nav { display: flex; gap: 4px; flex-wrap: wrap; padding: 10px 24px; background: var(--surface); border-bottom: 1px solid var(--border); }
nav a { color: var(--muted); text-decoration: none; padding: 6px 12px; border-radius: 6px; }
nav a.active { color: var(--text); background: var(--bg); font-weight: 600; }
.badge { display: inline-block; min-width: 20px; margin-left: 6px; padding: 0 6px; border-radius: 10px; background: var(--accent); color: var(--accent-text); font-size: 12px; text-align: center; }
main { max-width: 860px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 17px; margin: 32px 0 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
.card h3 { margin: 0 0 4px; font-size: 16px; }
.meta { color: var(--muted); font-size: 13px; margin: 2px 0; }
.note { background: var(--warn-bg); color: var(--warn-text); border-radius: 6px; padding: 6px 10px; margin: 8px 0; font-size: 14px; }
.draft { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 10px 0; white-space: pre-wrap; }
.saved { color: var(--ok); font-weight: 600; }
textarea, select, input[type=text] { width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
textarea { min-height: 90px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
details { margin-top: 10px; } summary { cursor: pointer; color: var(--accent); }
.empty { color: var(--muted); }
`;

export function Layout(props: { active: string; inboxCount: number; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>AI Applier</title>
        <style>{raw(CSS)}</style>
        <script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
      </head>
      <body>
        <nav>
          {TABS.map(t => (
            <a href={t.href} class={t.key === props.active ? "active" : ""}>
              {t.label}
              {t.key === "inbox" && props.inboxCount > 0 ? <span class="badge">{props.inboxCount}</span> : null}
            </a>
          ))}
        </nav>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
