import type { Db } from "../../db/db.js";
import { getSettings } from "../../settings.js";
import { Layout } from "../layout.js";
import { inboxCount } from "./inbox.js";

export function SettingsPage(props: { db: Db; keySet: boolean | null; notice?: string; error?: string }) {
  const s = getSettings(props.db);
  return (
    <Layout active="settings" inboxCount={inboxCount(props.db)}>
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
    </Layout>
  );
}
