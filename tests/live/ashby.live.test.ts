import { describe, expect, it } from "vitest";
import { ashby } from "../../src/ats/ashby.js";
import { dryRun } from "./dry-run.js";

// Current postings (Oct 2026); replace when they close. Dry runs never click submit.
const POSTINGS = [
  "https://jobs.ashbyhq.com/hiya/046212dd-41e3-46e7-a8ba-48cff5a7f947/application", // location typeahead, Yes/No buttons, native radios, texting consent
  "https://jobs.ashbyhq.com/niantic-spatial/ed68b062-4dcb-4deb-9cc0-ed38030f6e43/application", // three Yes/No buttons, url input
  "https://jobs.ashbyhq.com/skydio/fe26fdf8-15b2-44e6-8e43-ace13431453c/application", // optional cover letter upload, Yes/No
  "https://jobs.ashbyhq.com/normalcomputing/edfcbcf6-047f-4c12-801b-c78b199e0080/application", // country typeahead
];

describe.skipIf(!process.env.LIVE)("ashby (live dry run)", () => {
  it.each(POSTINGS)("fills every required field on %s", async url => {
    const { fields, unfilledRequired, submitVisible } = await dryRun(ashby, url);
    console.log(`[ashby] ${url}: ${fields.length} fields, ${fields.filter(f => f.required).length} required, ${fields.filter(f => f.kind === "radio" && f.options?.join() === "Yes,No").length} yes/no`);
    expect(fields.length).toBeGreaterThan(3);
    expect(unfilledRequired).toEqual([]);
    expect(submitVisible).toBe(true);
  }, 240000);
});
