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

test("values that spreadsheets would run as formulas get a leading apostrophe", () => {
  const db = openDb(":memory:");
  for (const title of ["=1+1", "@SUM(A1)", "+cmd", "-2", "Normal Intern"]) seedJob(db, { status: "submitted", title });
  const dir = mkdtempSync(path.join(tmpdir(), "csv-"));
  const file = path.join(dir, "a.csv");
  writeTrackerCsv(db, file);
  const text = readFileSync(file, "utf8");
  for (const t of ["'=1+1", "'@SUM(A1)", "'+cmd", "'-2"]) expect(text).toContain(`,${t},`);
  expect(text).toContain(",Normal Intern,");
  expect(text).not.toMatch(/,[=@+]/);
  expect(text).toMatch(/\n2026-10-28,/);
});
