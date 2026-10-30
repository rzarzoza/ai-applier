import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { openDb, type Db } from "../../src/db/db.js";
import { getJson, setJson } from "../../src/settings.js";
import { TRACKER_HEADERS } from "../../src/tracker/rows.js";
import type { SheetsClient } from "../../src/tracker/sheets.js";
import { syncTracker } from "../../src/tracker/sync.js";
import { seedJob } from "./seed.js";

let db: Db;
let csvFile: string;
const now = () => new Date("2026-10-28T20:00:00.000Z");
beforeEach(() => {
  db = openDb(":memory:");
  csvFile = path.join(mkdtempSync(path.join(tmpdir(), "sync-")), "applications.csv");
  seedJob(db, { status: "submitted", resume: "resume.pdf", cover: "none" });
});
const URL_OK = "https://docs.google.com/spreadsheets/d/abc123/edit";

test("syncTracker writes CSV and skips the sheet when not configured", async () => {
  const r = await syncTracker(db, { now, csvFile });
  expect(r).toMatchObject({ csv: true, sheet: "skipped" });
  expect(readFileSync(csvFile, "utf8")).toContain("resume.pdf");
  expect(getJson(db, "trackerSync", null)).toEqual({ lastSyncAt: now().toISOString(), lastError: null });
});

test("a sheet URL without a service-account key is skipped", async () => {
  setJson(db, "trackerSheetUrl", URL_OK);
  expect(await syncTracker(db, { now, csvFile, secrets: { get: async () => null } })).toMatchObject({ sheet: "skipped" });
});

test("syncTracker sends headers + rows to replaceTab and records success", async () => {
  setJson(db, "trackerSheetUrl", URL_OK);
  const replaceTab = vi.fn(async () => {});
  const r = await syncTracker(db, { sheets: { replaceTab }, now, csvFile });
  expect(r).toMatchObject({ csv: true, sheet: "ok" });
  expect(replaceTab).toHaveBeenCalledWith("abc123", "Applications", [TRACKER_HEADERS, expect.arrayContaining(["resume.pdf", "none"])]);
  expect(getJson<{ lastError: string | null }>(db, "trackerSync", { lastError: "unset" }).lastError).toBeNull();
});

test("a failing sheet client is reported, not thrown, and the CSV is still written", async () => {
  setJson(db, "trackerSheetUrl", URL_OK);
  const sheets: SheetsClient = { replaceTab: async () => { throw new Error("403 PERMISSION_DENIED") } };
  const r = await syncTracker(db, { sheets, now, csvFile });
  expect(r).toMatchObject({ csv: true, sheet: "error", error: expect.stringContaining("403") });
  expect(getJson<{ lastError: string }>(db, "trackerSync", { lastError: "unset" }).lastError).toContain("403");
  expect(readFileSync(csvFile, "utf8")).toContain("resume.pdf");
});

test("a Keychain failure or CSV failure never throws", async () => {
  setJson(db, "trackerSheetUrl", URL_OK);
  const r = await syncTracker(db, { now, csvFile, secrets: { get: async () => { throw new Error("locked"); } } });
  expect(r).toMatchObject({ sheet: "error", error: expect.stringContaining("locked") });
  const bad = await syncTracker(db, { now, csvFile: path.join(csvFile, "nope", "x.csv") });
  expect(bad.error).toBeTruthy();
});

test("a stored service-account key builds the sheets client", async () => {
  setJson(db, "trackerSheetUrl", URL_OK);
  const make = vi.fn(() => ({ replaceTab: async () => {} }));
  const r = await syncTracker(db, { now, csvFile, secrets: { get: async () => '{"k":1}' }, makeClient: make });
  expect(r.sheet).toBe("ok");
  expect(make).toHaveBeenCalledWith('{"k":1}');
});
