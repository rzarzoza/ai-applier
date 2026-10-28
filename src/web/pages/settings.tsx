import type { Db } from "../../db/db.js";
import { getJson, getSettings } from "../../settings.js";
import { SHEET_URL_KEY, SYNC_KEY, type TrackerSyncState } from "../../tracker/sync.js";
import { Layout, pauseProps } from "../layout.js";
import { inboxCount } from "./inbox.js";

export function SettingsPage(props: {
  db: Db; keySet: boolean | null; notice?: string; error?: string;
  /** Service-account email: null when no key is stored, undefined when the Keychain could not be read. */
  serviceEmail?: string | null; trackerError?: string; urlDraft?: string;
}) {
  const s = getSettings(props.db);
  const sheetUrl = props.urlDraft ?? getJson<string>(props.db, SHEET_URL_KEY, "");
  const sync = getJson<TrackerSyncState | null>(props.db, SYNC_KEY, null);
  return (
    <Layout active="settings" inboxCount={inboxCount(props.db)} {...pauseProps(props.db)}>
      <h1>Settings</h1>
      {props.notice ? <div class="card saved">{props.notice}</div> : null}
      {props.error ? <div class="note">{props.error}</div> : null}
      <form method="post" action="/settings" class="card">
        <label class="meta" style="display:block;margin:8px 0">
          Review before submitting
          <select name="reviewMode">
            <option value="off" selected={s.reviewMode === "off"}>Never (submit automatically)</option>
            <option value="all" selected={s.reviewMode === "all"}>Always</option>
            <option value="companies" selected={s.reviewMode === "companies"}>Only for these companies</option>
          </select>
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          Review companies (comma-separated)
          <input type="text" name="reviewCompanies" value={s.reviewCompanies.join(", ")} />
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          Daily limit (blank for no limit)
          <input type="text" name="dailyLimit" value={s.dailyLimit === null ? "" : String(s.dailyLimit)} />
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          Poll every (minutes)
          <input type="text" name="pollMinutes" value={String(s.pollMinutes)} />
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          <input type="checkbox" name="headless" value="1" checked={s.headless} /> Run the browser headless
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          <input type="checkbox" name="paused" value="1" checked={s.paused} /> Paused
        </label>
        <label class="meta" style="display:block;margin:8px 0">
          Anthropic API key: {props.keySet === null ? "unknown (could not read the Keychain)" : props.keySet ? "set ✓" : "not set"}
          <input type="password" name="apiKey" value="" autocomplete="off" placeholder="Leave blank to keep the current key" />
        </label>
        <div class="row"><button class="primary" type="submit">Save settings</button></div>
      </form>
      <div class="card">
        <h2>Tracker spreadsheet</h2>
        <p class="meta">Every submitted application is saved to a local spreadsheet (<a href="/tracker.csv">download applications.csv</a>). Optionally it is also kept up to date in a Google Sheet.</p>
        {props.trackerError ? <div class="note">{props.trackerError}</div> : null}
        <form method="post" action="/tracker/url">
          <label class="meta" style="display:block;margin:8px 0">
            Google Sheet URL (blank to turn off)
            <input type="text" name="url" value={sheetUrl} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </label>
          <div class="row"><button type="submit">Save Sheet URL</button></div>
        </form>
        <form method="post" action="/tracker/key" enctype="multipart/form-data">
          <label class="meta" style="display:block;margin:8px 0">
            Service-account key (JSON file): {props.serviceEmail === undefined ? "unknown (could not read the Keychain)" : props.serviceEmail ? "set ✓" : "not set"}
            <input type="file" name="key" accept="application/json,.json" />
          </label>
          {props.serviceEmail ? <p class="meta">Share your Sheet with <strong>{props.serviceEmail}</strong> (Editor access).</p> : null}
          <div class="row"><button type="submit">Upload key</button></div>
        </form>
        <p class="meta">
          {sync?.lastSyncAt ? `Last sync: ${sync.lastSyncAt}` : "Not synced yet"}
          {sync?.lastError ? <span> · Error: {sync.lastError}</span> : null}
        </p>
        <form method="post" action="/tracker/sync"><div class="row"><button class="primary" type="submit">Sync now</button></div></form>
      </div>
    </Layout>
  );
}
