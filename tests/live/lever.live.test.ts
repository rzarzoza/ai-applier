import { describe, expect, it } from "vitest";
import { lever } from "../../src/ats/lever.js";
import { dryRun } from "./dry-run.js";

// Current postings (Oct 2026); replace when they close. Dry runs never click submit.
const POSTINGS = [
  "https://jobs.lever.co/tri/6f60ff79-c902-466a-912c-7ab849ce6424/apply", // cards: radios + textarea, eeo selects
  "https://jobs.lever.co/cfsenergy/32987ab7-59ed-4364-a012-91cbece8877a/apply",
  "https://jobs.eu.lever.co/cirrus/533c9938-3d35-48a6-b08b-1dd1675d2bdf/apply", // EU host
];

describe.skipIf(!process.env.LIVE)("lever (live dry run)", () => {
  it.each(POSTINGS)("fills every required field on %s", async url => {
    const { fields, unfilledRequired, submitVisible } = await dryRun(lever, url);
    console.log(`[lever] ${url}: ${fields.length} fields, ${fields.filter(f => f.required).length} required`);
    expect(fields.length).toBeGreaterThan(3);
    expect(unfilledRequired).toEqual([]);
    expect(submitVisible).toBe(true);
  }, 240000);
});
