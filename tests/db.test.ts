import { expect, test } from "vitest";
import { openDb } from "../src/db/db.js";
import { migrations } from "../src/db/migrations.js";

test("openDb runs migrations once and records user_version", () => {
  const db = openDb(":memory:");
  const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
  expect(v.user_version).toBe(migrations.length);
  expect(() => db.prepare("SELECT key, value FROM kv").all()).not.toThrow();
});
