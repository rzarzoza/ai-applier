import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { DEFAULT_FILTERS, evaluateFilters, getFilters, saveFilters } from "../../src/filters/filters.js";
import type { Posting } from "../../src/sources/types.js";

const base: Posting = { sourceId: "s", listingId: "1", company: "Acme", title: "Software Engineer Intern",
  locations: ["Toronto, ON, Canada", "NYC"], category: "Software", terms: ["Summer 2027"], degrees: ["Bachelor's"],
  sponsorship: "Other", url: "https://x", datePosted: new Date("2026-10-20"), active: true };
const now = new Date("2026-10-27");
test("any-mode passes on the first non-excluded location", () =>
  expect(evaluateFilters(base, DEFAULT_FILTERS, now)).toEqual({ pass: true, location: "NYC" }));
test("all-Canada posting is rejected with a reason", () =>
  expect(evaluateFilters({ ...base, locations: ["Toronto, ON, Canada"] }, DEFAULT_FILTERS, now))
    .toEqual({ pass: false, reason: expect.stringContaining("Canada") }));
test("category, age, company, title rules", () => {
  expect(evaluateFilters({ ...base, category: "Hardware" }, DEFAULT_FILTERS, now).pass).toBe(false);
  expect(evaluateFilters({ ...base, datePosted: new Date("2026-10-01") }, DEFAULT_FILTERS, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, excludeCompanies: ["acme"] }, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, titleBlock: ["phd"] }, now).pass).toBe(true);
  expect(evaluateFilters({ ...base, title: "PhD Software Intern" }, { ...DEFAULT_FILTERS, titleBlock: ["phd"] }, now).pass).toBe(false);
});
test("includeCountries USA rejects Unknown-only postings", () =>
  expect(evaluateFilters({ ...base, locations: ["Remote"] }, { ...DEFAULT_FILTERS, includeCountries: ["USA"] }, now).pass).toBe(false));
test("all-mode requires every location to pass", () => {
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, locationMode: "all" }, now).pass).toBe(false);
  expect(evaluateFilters({ ...base, locations: ["NYC", "Seattle, WA"] }, { ...DEFAULT_FILTERS, locationMode: "all" }, now))
    .toEqual({ pass: true, location: "NYC" });
});
test("title require, include/exclude locations, degrees, null age filter", () => {
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, titleRequire: ["data"] }, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, titleRequire: ["SOFTWARE"] }, now).pass).toBe(true);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, includeLocations: ["seattle"] }, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, excludeLocations: ["nyc"] }, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, degrees: ["PhD"] }, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, degrees: ["Bachelor's"] }, now).pass).toBe(true);
  expect(evaluateFilters({ ...base, datePosted: new Date("2020-01-01") }, { ...DEFAULT_FILTERS, postedWithinDays: null }, now).pass).toBe(true);
});
test("getFilters returns defaults, saveFilters persists", () => {
  const db = openDb(":memory:");
  expect(getFilters(db)).toEqual(DEFAULT_FILTERS);
  saveFilters(db, { ...DEFAULT_FILTERS, titleBlock: ["phd"] });
  expect(getFilters(db).titleBlock).toEqual(["phd"]);
});
