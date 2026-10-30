import { describe, expect, it } from "vitest";
import { greenhouse } from "../../src/ats/greenhouse.js";
import { dryRun } from "./dry-run.js";

// Current postings (Oct 2026); replace when they close. Dry runs never click submit.
const POSTINGS = [
  "https://job-boards.greenhouse.io/acluinternships/jobs/8919540002",
  "https://boards.greenhouse.io/embed/job_app?token=6866538002", // Databricks: education, async selects, checkbox groups, 4 uploads
  "https://www.mongodb.com/careers/job/?gh_jid=8209134", // company page embedding the form in an iframe
];

describe.skipIf(!process.env.LIVE)("greenhouse (live dry run)", () => {
  it.each(POSTINGS)("fills every required field on %s", async url => {
    const { fields, unfilledRequired, submitVisible } = await dryRun(greenhouse, url);
    console.log(`[greenhouse] ${url}: ${fields.length} fields, ${fields.filter(f => f.required).length} required`);
    expect(fields.length).toBeGreaterThan(3);
    expect(unfilledRequired).toEqual([]);
    expect(submitVisible).toBe(true);
  }, 240000);
});
