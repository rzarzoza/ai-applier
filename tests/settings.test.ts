import { expect, test } from "vitest";
import { openDb } from "../src/db/db.js";
import { DEFAULT_SETTINGS, getJson, getSettings, saveSettings, setJson } from "../src/settings.js";

test("getSettings returns defaults, saveSettings merges", () => {
  const db = openDb(":memory:");
  expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
  saveSettings(db, { reviewMode: "all", dailyLimit: 20 });
  expect(getSettings(db)).toMatchObject({ reviewMode: "all", dailyLimit: 20, pollMinutes: 30 });
});

test("a stored headless value from an older version is ignored and dropped on the next save", () => {
  const db = openDb(":memory:");
  setJson(db, "settings", { headless: true, pollMinutes: 60 });
  expect(getSettings(db)).toEqual({ ...DEFAULT_SETTINGS, pollMinutes: 60 });
  saveSettings(db, { paused: true });
  expect(getJson(db, "settings", {})).not.toHaveProperty("headless");
});
