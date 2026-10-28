import type { Db } from "../../db/db.js";
import { getJson, getSettings } from "../../settings.js";
import { SHEET_URL_KEY, SYNC_KEY, type TrackerSyncState } from "../../tracker/sync.js";
import { Alert, Layout, pauseProps } from "../layout.js";
import { Chip, PageHead } from "../ui.js";
import { inboxCount } from "./inbox.js";

export function SettingsPage(props: {
  db: Db; keySet: boolean | null; notice?: string; error?: string;
  /** Service-account email: null when no key is stored, undefined when the Keychain could not be read. */
  serviceEmail?: string | null; trackerError?: string; urlDraft?: string;
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
    </Layout>
  );
}
