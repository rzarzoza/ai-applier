import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { writeTrackerCsv } from "../../src/tracker/csv.js";
import { seedJob } from "./seed.js";

test("CSV quotes commas, quotes and newlines and is rewritten, not appended", () => {
  const db = openDb(":memory:");
  seedJob(db, { status: "submitted", title: 'Intern, "AI"', company: "Line\nBreak" });
  const dir = mkdtempSync(path.join(tmpdir(), "csv-"));
  const file = path.join(dir, "applications.csv");
  writeTrackerCsv(db, file);
  const first = readFileSync(file, "utf8");
  writeTrackerCsv(db, file);
  expect(readFileSync(file, "utf8")).toBe(first);
  expect(first.split("\r\n")[0]).toBe("Date applied,Company,Job title,Posting link,Location,Resume used,Cover letter used,Status,Application system");
  expect(first).toContain('"Intern, ""AI"""');
  expect(first).toContain('"Line\nBreak"');
  expect(readdirSync(dir)).toEqual(["applications.csv"]);
});
