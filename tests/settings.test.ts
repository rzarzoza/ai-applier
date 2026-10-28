import { expect, test } from "vitest";
import { openDb } from "../src/db/db.js";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "../src/settings.js";

test("getSettings returns defaults, saveSettings merges", () => {
  const db = openDb(":memory:");
  expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
  saveSettings(db, { reviewMode: "all", dailyLimit: 20 });
  expect(getSettings(db)).toMatchObject({ reviewMode: "all", dailyLimit: 20, pollMinutes: 30, headless: false });
});
