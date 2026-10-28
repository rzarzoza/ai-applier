import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { TRACKER_HEADERS, trackerRows } from "../../src/tracker/rows.js";
import { seedJob } from "./seed.js";

test("trackerRows lists submitted + applied-manually jobs with all columns, newest first", () => {
  const db = openDb(":memory:");
  seedJob(db, { status: "submitted", title: "Software Engineer Intern", url: "https://job-boards.greenhouse.io/acme/jobs/1", resume: "resume.pdf", cover: "none" });
  seedJob(db, { status: "applied-manually", company: "Globex", title: "Data Intern", url: "https://example.com/x", location: null, at: "2026-10-30T12:00:00.000Z" });
  seedJob(db, { status: "queued" });
  const rows = trackerRows(db);
  expect(TRACKER_HEADERS).toHaveLength(9);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(["2026-10-30", "Globex", "Data Intern", "https://example.com/x", "", "", "", "applied-manually", "other"]);
  expect(rows[1]).toEqual(["2026-10-28", "Acme", "Software Engineer Intern", "https://job-boards.greenhouse.io/acme/jobs/1", "NYC", "resume.pdf", "none", "submitted", "greenhouse"]);
});
