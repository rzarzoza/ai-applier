import { expect, test } from "vitest";
import { atsNameFromUrl, detectAts } from "../../src/ats/registry.js";

test("detectAts routes by URL", () => {
  expect(detectAts("https://job-boards.greenhouse.io/digs/jobs/4663939006")?.name).toBe("greenhouse");
  expect(detectAts("http://block.xyz/careers/jobs/5108007008?gh_jid=5108007008")?.name).toBe("greenhouse");
  expect(detectAts("https://visa.wd5.myworkdayjobs.com/Visa/job/x")).toBeNull();
  expect(atsNameFromUrl("https://visa.wd5.myworkdayjobs.com/Visa/job/x")).toBe("workday");
});

test("greenhouse matches its board hosts and gh_jid links only", () => {
  for (const u of [
    "https://boards.greenhouse.io/parallel/jobs/5275690007",
    "https://job-boards.eu.greenhouse.io/acme/jobs/1",
    "https://boards.greenhouse.io/embed/job_app?token=6866538002",
    "https://careers.withwaymo.com/jobs?gh_jid=8304574",
  ]) expect(detectAts(u)?.name, u).toBe("greenhouse");
  for (const u of ["https://acme.wd1.myworkdayjobs.com/x/job/y", "https://evil.com/greenhouse.io/jobs/1", "not a url", ""]) expect(detectAts(u), u).toBeNull();
});

test("detectAts uses the given handler list", () => {
  expect(detectAts("https://job-boards.greenhouse.io/digs/jobs/1", [])).toBeNull();
});

test("atsNameFromUrl names the ATS for display", () => {
  expect(atsNameFromUrl("https://boards.greenhouse.io/x/jobs/1")).toBe("greenhouse");
  expect(atsNameFromUrl("https://www.mongodb.com/careers/job/?gh_jid=8209134")).toBe("greenhouse");
  expect(atsNameFromUrl("https://jobs.lever.co/cfsenergy/32987ab7/apply")).toBe("lever");
  expect(atsNameFromUrl("https://jobs.eu.lever.co/cirrus/533c/apply")).toBe("lever");
  expect(atsNameFromUrl("https://jobs.ashbyhq.com/skydio/6f5c/application")).toBe("ashby");
  expect(atsNameFromUrl("https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1")).toBe("oracle");
  expect(atsNameFromUrl("https://jobs.smartrecruiters.com/Visa/7439")).toBe("smartrecruiters");
  expect(atsNameFromUrl("https://wd1.myworkdaysite.com/recruiting/x/y")).toBe("workday");
  expect(atsNameFromUrl("https://careers.example.com/jobs/1")).toBe("other");
  expect(atsNameFromUrl("garbage")).toBe("other");
});

test("detectAts routes Lever postings on both hosts", () => {
  expect(detectAts("https://jobs.lever.co/x/y")?.name).toBe("lever");
  expect(detectAts("https://jobs.eu.lever.co/x/y/apply")?.name).toBe("lever");
});
