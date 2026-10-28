import type { Db } from "../db/db.js";
import { getJson, setJson } from "../settings.js";
import { writeTrackerCsv } from "./csv.js";
import { TRACKER_HEADERS, trackerRows } from "./rows.js";
import { googleSheetsClient, spreadsheetIdFromUrl, type SheetsClient } from "./sheets.js";

export const SERVICE_ACCOUNT_SECRET = "google-service-account";
export const SHEET_URL_KEY = "trackerSheetUrl";
export const SYNC_KEY = "trackerSync";
const TAB = "Applications";

export interface TrackerSyncState { lastSyncAt: string | null; lastError: string | null }
export interface SyncResult { csv: true; sheet: "ok" | "skipped" | "error"; error?: string }

export interface SyncDeps {
  /** A ready client (tests). Otherwise one is built from the stored service-account key. */
  sheets?: SheetsClient;
  secrets?: { get(name: string): Promise<string | null> };
  makeClient?: (serviceAccountJson: string) => SheetsClient;
  now(): Date;
  csvFile?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/** Always rewrites the CSV; pushes to the Google Sheet when it is configured. Never throws. */
export async function syncTracker(db: Db, deps: SyncDeps): Promise<SyncResult> {
  const errors: string[] = [];
  let sheet: SyncResult["sheet"] = "skipped";
  try {
    writeTrackerCsv(db, deps.csvFile);
  } catch (e) {
    errors.push(`CSV: ${errText(e)}`);
  }
  try {
    const id = spreadsheetIdFromUrl(getJson<string>(db, SHEET_URL_KEY, ""));
    let client = deps.sheets;
    if (id && !client && deps.secrets) {
      const key = await deps.secrets.get(SERVICE_ACCOUNT_SECRET);
      if (key) client = (deps.makeClient ?? googleSheetsClient)(key);
    }
    if (id && client) {
      sheet = "error";
      await client.replaceTab(id, TAB, [TRACKER_HEADERS, ...trackerRows(db)]);
      sheet = "ok";
    }
  } catch (e) {
    sheet = "error";
    errors.push(errText(e));
  }
  const error = errors.length ? errors.join("; ") : undefined;
  try {
    setJson(db, SYNC_KEY, { lastSyncAt: deps.now().toISOString(), lastError: error ?? null } satisfies TrackerSyncState);
  } catch { /* the result below still reports it */ }
  return { csv: true, sheet, ...(error ? { error } : {}) };
}
