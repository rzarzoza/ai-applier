import { raw } from "hono/html";
import type { Db } from "../../db/db.js";
import { CLAUDE_FAST_MODEL, CLAUDE_WRITE_MODEL } from "../../llm/llm.js";
import { claudeSpendToday, formatUsd, spendByTask, startOfDay, startOfDaysAgo, type TaskSpend } from "../../llm/meter.js";
import { claudeInUse } from "../../llm/routed.js";
import { getJson, getSettings, type Settings } from "../../settings.js";
import { SHEET_URL_KEY, SYNC_KEY, type TrackerSyncState } from "../../tracker/sync.js";
import { Alert, Layout, pauseProps } from "../layout.js";
import { Chip, PageHead } from "../ui.js";
import { inboxCount } from "./inbox.js";

export function SettingsPage(props: {
  db: Db; keySet: boolean | null; notice?: string; error?: string;
  /** Service-account email: null when no key is stored, undefined when the Keychain could not be read. */
  serviceEmail?: string | null; trackerError?: string; urlDraft?: string;
  /** The browser extension's pairing token (see ext/api.ts). */
  extToken?: string;
}) {
  const s = getSettings(props.db);
  const sheetUrl = props.urlDraft ?? getJson<string>(props.db, SHEET_URL_KEY, "");
  const sync = getJson<TrackerSyncState | null>(props.db, SYNC_KEY, null);
  const keyChip = (state: boolean | null | undefined, unknown: string) => state === null || state === undefined
    ? <Chip cls="chip-amber">{unknown}</Chip>
    : state ? <Chip cls="chip-green">set ✓</Chip> : <Chip cls="chip-gray">not set</Chip>;
  return (
    <Layout active="settings" inboxCount={inboxCount(props.db)} {...pauseProps(props.db)} title="Settings">
      <PageHead title="Settings" subtitle="How and when the applier submits, and where it keeps track." />
      {props.notice ? <Alert kind="success">{props.notice}</Alert> : null}
      {props.error ? <Alert kind="danger">{props.error}</Alert> : null}
      <form method="post" action="/settings" class="card">
        <div class="card-head"><h2>Applying</h2></div>
        <div class="fields-grid">
          <label class="field">
            <span>Review before submitting</span>
            <select name="reviewMode">
              <option value="off" selected={s.reviewMode === "off"}>Never (submit automatically)</option>
              <option value="all" selected={s.reviewMode === "all"}>Always</option>
              <option value="companies" selected={s.reviewMode === "companies"}>Only for these companies</option>
            </select>
          </label>
          <label class="field">
            <span>Review companies <span class="hint">(comma-separated)</span></span>
            <input type="text" name="reviewCompanies" value={s.reviewCompanies.join(", ")} />
          </label>
          <label class="field">
            <span>Daily limit <span class="hint">(blank for no limit)</span></span>
            <input type="text" name="dailyLimit" value={s.dailyLimit === null ? "" : String(s.dailyLimit)} />
          </label>
          <label class="field">
            <span>Poll every <span class="hint">(minutes)</span></span>
            <input type="text" name="pollMinutes" value={String(s.pollMinutes)} />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" name="paused" value="1" checked={s.paused} /> Paused
        </label>
        <hr class="divider" />
        <label class="field">
          <span>Anthropic API key {keyChip(props.keySet, "unknown (could not read the Keychain)")}</span>
          <input type="password" name="apiKey" value="" autocomplete="off" placeholder="Leave blank to keep the current key" />
        </label>
        <div class="form-foot"><button class="primary" type="submit">Save settings</button></div>
      </form>
      <section class="card">
        <div class="card-head"><h2>Tracker spreadsheet</h2></div>
        <p class="meta">Every submitted application is saved to a local spreadsheet (<a href="/tracker.csv">download applications.csv</a>). Optionally it is also kept up to date in a Google Sheet.</p>
        {props.trackerError ? <div class="note">{props.trackerError}</div> : null}
        <form method="post" action="/tracker/url">
          <label class="field">
            <span>Google Sheet URL <span class="hint">(blank to turn off)</span></span>
            <input type="text" name="url" value={sheetUrl} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </label>
          <div class="form-foot"><button type="submit">Save Sheet URL</button></div>
        </form>
        <hr class="divider" />
        <form method="post" action="/tracker/key" enctype="multipart/form-data">
          <label class="field">
            <span>Service-account key (JSON file) {keyChip(props.serviceEmail === undefined ? undefined : !!props.serviceEmail, "unknown (could not read the Keychain)")}</span>
            <input type="file" name="key" accept="application/json,.json" />
          </label>
          {props.serviceEmail ? <p class="meta">Share your Sheet with <strong>{props.serviceEmail}</strong> (Editor access).</p> : null}
          <div class="form-foot"><button type="submit">Upload key</button></div>
        </form>
        <hr class="divider" />
        <div class="row" style="justify-content:space-between;margin-top:0">
          <p class="meta" style="margin:0">
            {sync?.lastSyncAt ? `Last sync: ${sync.lastSyncAt}` : "Not synced yet"}
            {sync?.lastError ? <span> · Error: {sync.lastError}</span> : null}
          </p>
          <form method="post" action="/tracker/sync"><button class="primary" type="submit">Sync now</button></form>
        </div>
      </section>
      <AiCard db={props.db} s={s} />
      {props.extToken ? <ExtensionCard token={props.extToken} /> : null}
    </Layout>
  );
}

// Static script (no user text): copies the token next to the button.
const COPY_JS = `document.addEventListener("click", e => {
  const b = e.target.closest("[data-copy-input]");
  if (!b) return;
  const input = document.getElementById(b.getAttribute("data-copy-input"));
  input.select();
  (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject()).catch(() => document.execCommand("copy"));
  b.textContent = "Copied";
  setTimeout(() => { b.textContent = "Copy"; }, 1500);
});`;

/** Pairing the browser extension: its token, a copy button, and how to install it. */
function ExtensionCard(props: { token: string }) {
  return (
    <section class="card" id="extension">
      <div class="card-head"><h2>Browser extension</h2></div>
      <p class="meta">The AI Applier extension fills applications you open in your own Chrome, using this app's profile and answer bank. It never submits: you review and click Submit, and what you typed is saved to the bank.</p>
      <label class="field">
        <span>Pairing token</span>
        <div class="row" style="margin-top:0;flex-wrap:nowrap">
          <input type="text" id="ext-token" value={props.token} readonly style="flex:1;font-family:ui-monospace,monospace" />
          <button type="button" data-copy-input="ext-token">Copy</button>
        </div>
      </label>
      <ol class="meta">
        <li>Build it once: <code>pnpm build:ext</code></li>
        <li>In Chrome open <code>chrome://extensions</code>, turn on Developer mode, click <strong>Load unpacked</strong> and pick the <code>extension/dist</code> folder.</li>
        <li>Click the extension's icon, paste this token and click Save.</li>
      </ol>
      <form method="post" action="/settings/extension-token" class="form-foot">
        <button type="submit">New token</button>
      </form>
      <script>{raw(COPY_JS)}</script>
    </section>
  );
}

const TASK_LABEL: Record<string, string> = {
  classify: "Classify fields", match: "Match bank questions", adapt: "Map answers to options", variants: "Other names",
  fact: "Factual answers", draft: "Drafts", revise: "Revisions", template: "Templates", resume: "Resume import",
};

/** The models Settings offer for one task category. */
function ProviderSelect(props: { name: string; value: Settings["aiFast"]; claudeModel: string; s: Settings }) {
  return (
    <select name={props.name}>
      <option value="local" selected={props.value === "local"}>Local ({props.s.ollamaModel}) — free</option>
      <option value="claude" selected={props.value === "claude"}>Claude ({props.claudeModel}) — paid, within the daily budget</option>
    </select>
  );
}

function SpendTable(props: { rows: TaskSpend[]; empty: string }) {
  if (!props.rows.length) return <p class="meta">{props.empty}</p>;
  const total = props.rows.reduce((a, r) => ({ calls: a.calls + r.calls, cost: a.cost + r.costUsd }), { calls: 0, cost: 0 });
  return (
    <table class="spend">
      <thead><tr><th>Task</th><th>Calls</th><th>On your Mac</th><th>Tokens in / out</th><th>Cost</th></tr></thead>
      <tbody>
        {props.rows.map(r => (
          <tr>
            <td>{TASK_LABEL[r.task] ?? r.task}</td><td>{r.calls}</td><td>{r.local}</td>
            <td>{r.inputTokens.toLocaleString("en-US")} / {r.outputTokens.toLocaleString("en-US")}</td><td>{formatUsd(r.costUsd)}</td>
          </tr>
        ))}
        <tr><td><strong>Total</strong></td><td><strong>{total.calls}</strong></td><td></td><td></td><td><strong>{formatUsd(total.cost)}</strong></td></tr>
      </tbody>
    </table>
  );
}

/** Where the AI runs, what it may cost, and what it has cost (today and the last 7 days, by task). */
function AiCard(props: { db: Db; s: Settings }) {
  const { s, db } = props;
  const allLocal = !claudeInUse(s);
  const claudeToday = claudeSpendToday(db);
  return (
    <section class="card" id="ai">
      <div class="card-head"><h2>AI</h2>{allLocal ? <span class="chip chip-green">Free</span> : <span class="chip chip-amber">Claude on</span>}</div>
      <p class="meta">
        {allLocal
          ? <>AI runs on your Mac (Ollama · {s.ollamaModel}) — free. Nothing is sent to Anthropic.</>
          : <>Some tasks use Claude (paid). Claude spend today: <strong>{formatUsd(claudeToday)}</strong> of {formatUsd(s.aiDailyBudgetUsd)}.</>}
      </p>
      <form method="post" action="/settings/ai">
        <div class="fields-grid">
          <label class="field">
            <span>Quick tasks <span class="hint">(classify fields, match questions, map answers to options, facts)</span></span>
            <ProviderSelect name="aiFast" value={s.aiFast} claudeModel={CLAUDE_FAST_MODEL} s={s} />
          </label>
          <label class="field">
            <span>Writing <span class="hint">(drafts, revisions, templates, resume import)</span></span>
            <ProviderSelect name="aiWrite" value={s.aiWrite} claudeModel={CLAUDE_WRITE_MODEL} s={s} />
          </label>
          <label class="field">
            <span>Ollama address</span>
            <input type="text" name="ollamaUrl" value={s.ollamaUrl} />
          </label>
          <label class="field">
            <span>Local model</span>
            <input type="text" name="ollamaModel" value={s.ollamaModel} />
          </label>
          <label class="field">
            <span>If the local model is off</span>
            <select name="aiLocalOff">
              <option value="leave" selected={s.aiLocalOff === "leave"}>Leave the field for me</option>
              <option value="claude" selected={s.aiLocalOff === "claude"}>Use Claude (within the daily budget)</option>
            </select>
          </label>
          <label class="field">
            <span>Daily AI budget <span class="hint">(US dollars of Claude per day)</span></span>
            <input type="text" name="aiDailyBudgetUsd" value={s.aiDailyBudgetUsd.toFixed(2)} />
          </label>
        </div>
        <div class="form-foot">
          <button type="button" hx-post="/settings/ai/test" hx-include="closest form" hx-target="#ollama-test" hx-swap="innerHTML">Test connection</button>
          <button class="primary" type="submit">Save AI settings</button>
        </div>
        <div id="ollama-test" aria-live="polite"></div>
      </form>
      <hr class="divider" />
      <h3>Today</h3>
      <SpendTable rows={spendByTask(db, startOfDay())} empty="No AI calls today." />
      <h3>Last 7 days</h3>
      <SpendTable rows={spendByTask(db, startOfDaysAgo(7))} empty="No AI calls in the last 7 days." />
    </section>
  );
}

/** "Test connection": the models Ollama has installed, and whether the chosen one is among them. */
export function OllamaTestResult(props: { models?: string[]; error?: string; model: string }) {
  if (props.error) return <div class="note">Couldn't reach Ollama: {props.error}</div>;
  const models = props.models ?? [];
  const has = models.includes(props.model) || models.includes(`${props.model}:latest`);
  return (
    <div class={has ? "meta" : "note"}>
      Connected. {models.length ? <>Installed: {models.join(", ")}.</> : <>No models installed.</>}{" "}
      {has ? <strong>{props.model} is ready.</strong> : <strong>{props.model} isn't installed — run: ollama pull {props.model}</strong>}
    </div>
  );
}
