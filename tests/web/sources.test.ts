import { expect, test } from "vitest";
import { getFilters } from "../../src/filters/filters.js";
import { setStatus, upsertPosting } from "../../src/jobs/repo.js";
import { listSources, setSourceEnabled } from "../../src/sources/repo.js";
import type { Posting } from "../../src/sources/types.js";
import { form, setupApp } from "./helpers.js";

const posting = (n: number, o: Partial<Posting> = {}): Posting => ({
  sourceId: "s", listingId: String(n), company: `Co${n}`, title: "SWE Intern", locations: ["New York, NY"], category: "Software",
  terms: [], degrees: [], sponsorship: null, url: `https://x.test/${n}`, datePosted: new Date(), active: true, ...o,
});

test("adding a GitHub repo URL creates a readme-table source with the raw README URL", async () => {
  const { db, app } = setupApp();
  const res = await app.request("/sources", form({ url: "https://github.com/SimplifyJobs/New-Grad-Positions" }));
  expect(res.status).toBe(303);
  const s = listSources(db).find(x => x.kind === "readme-table")!;
  expect(s.url).toBe("https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/HEAD/README.md");
  expect(s.enabled).toBe(true);
});

test("a URL ending listings.json creates a simplify-json source; junk and duplicates are rejected", async () => {
  const { db, app } = setupApp();
  const u = "https://raw.githubusercontent.com/o/r/dev/.github/scripts/listings.json";
  await app.request("/sources", form({ url: u }));
  expect(listSources(db).find(s => s.url === u)?.kind).toBe("simplify-json");
  const before = listSources(db).length;
  expect((await app.request("/sources", form({ url: u }))).status).toBe(400);
  expect((await app.request("/sources", form({ url: "javascript:alert(1)" }))).status).toBe(400);
  expect((await app.request("/sources", form({ url: "https://example.com/foo" }))).status).toBe(400);
  expect(listSources(db)).toHaveLength(before);
});

test("toggle enables/disables a source; poll calls pollNow", async () => {
  const { db, app, pollNow } = setupApp();
  const id = listSources(db)[0]!.id;
  await app.request(`/sources/${id}/toggle`, form({ enabled: "0" }));
  expect(listSources(db)[0]!.enabled).toBe(false);
  await app.request(`/sources/${id}/toggle`, form({ enabled: "1" }));
  expect(listSources(db)[0]!.enabled).toBe(true);
  expect((await app.request("/sources/poll", { method: "POST" })).status).toBe(303);
  expect(pollNow).toHaveBeenCalledTimes(1);
  setSourceEnabled(db, id, true);
});

test("GET /sources shows sources and the filter form", async () => {
  const { app } = setupApp();
  const html = await (await app.request("/sources")).text();
  expect(html).toContain("simplify-summer2027");
  expect(html).toContain('name="categories"');
  expect(html).toContain('value="Software, Software Engineering"');
  expect(html).toContain("not polled yet");
});

test("preview counts current jobs matching the default filters", async () => {
  const { db, app } = setupApp();
  upsertPosting(db, posting(1));
  upsertPosting(db, posting(2, { locations: ["Toronto, Canada"] }));
  upsertPosting(db, posting(3, { category: "Hardware" }));
  upsertPosting(db, posting(4, { datePosted: new Date("2020-01-01") }));
  const j = upsertPosting(db, posting(5)).job; setStatus(db, j.id, "skipped", "x");
  const html = await (await app.request("/filters/preview?categories=Software,Software Engineering&excludeCountries=Canada&postedWithinDays=14&locationMode=any")).text();
  expect(html).toContain("2 of 5 current postings match");
});

test("POST /filters saves lists, numbers and mode", async () => {
  const { db, app } = setupApp();
  const res = await app.request("/filters", form({
    categories: "Software, Data", includeCountries: "", excludeCountries: "Canada, India", includeLocations: "NYC", excludeLocations: "",
    locationMode: "all", postedWithinDays: "", excludeCompanies: "Evil Corp", titleRequire: "intern", titleBlock: "senior", degrees: "Bachelor's",
  }));
  expect(res.status).toBe(303);
  expect(getFilters(db)).toMatchObject({
    categories: ["Software", "Data"], includeCountries: [], excludeCountries: ["Canada", "India"], includeLocations: ["NYC"],
    locationMode: "all", postedWithinDays: null, excludeCompanies: ["Evil Corp"], titleRequire: ["intern"], titleBlock: ["senior"], degrees: ["Bachelor's"],
  });
});

test("Sources page shows each source's last poll error or OK with counts", async () => {
  const { db, app } = setupApp();
  const { setJson } = await import("../../src/settings.js");
  setJson(db, "pollReports", {
    "simplify-summer2027": { at: "2026-10-28T10:00:00.000Z", report: { sourceId: "simplify-summer2027", fetched: 300, newJobs: 12, queued: 5, skipped: 7, duplicates: 0, closed: 1 } },
  });
  let html = await (await app.request("/sources")).text();
  expect(html).toContain("OK");
  expect(html).toContain("300 fetched");
  setJson(db, "pollReports", {
    "simplify-summer2027": { at: "2026-10-28T10:00:00.000Z", report: { sourceId: "simplify-summer2027", fetched: 0, newJobs: 0, queued: 0, skipped: 0, duplicates: 0, closed: 0, error: "HTTP 500" } },
  });
  html = await (await app.request("/sources")).text();
  expect(html).toContain("Last error: HTTP 500");
});
