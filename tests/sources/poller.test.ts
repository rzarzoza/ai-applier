import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { countByStatus, listJobs, setStatus } from "../../src/jobs/repo.js";
import { pollAll } from "../../src/sources/poller.js";
import { addSource, listSources, setSourceEnabled } from "../../src/sources/repo.js";
import type { FetchResult, Posting, SourceAdapter } from "../../src/sources/types.js";

const now = new Date("2026-10-27");
const mk = (o: Partial<Posting>): Posting => ({ sourceId: "simplify-summer2027", listingId: "1", company: "Acme",
  title: "Software Engineer Intern", locations: ["NYC"], category: "Software", terms: ["Summer 2027"], degrees: [],
  sponsorship: null, url: "https://acme.test/1", datePosted: new Date("2026-10-20"), active: true, ...o });
const nyPosting = mk({});
const torontoOnly = mk({ listingId: "2", url: "https://acme.test/2", company: "Beta", locations: ["Toronto, ON, Canada"] });

const adapter = (fn: () => FetchResult | Error): SourceAdapter => ({
  async fetch() { const r = fn(); if (r instanceof Error) throw r; return r; },
});
const adaptersOf = (a: SourceAdapter) => ({ "simplify-json": a, "readme-table": a });
const fakeAdapters = (postings: Posting[], etag: string | null = '"e1"') =>
  adaptersOf(adapter(() => ({ notModified: false, etag, postings })));
const throwingAdapters = (e: Error) => adaptersOf(adapter(() => e));

test("new passing posting is queued with chosen location; failing one is skipped with reason", async () => {
  const db = openDb(":memory:");
  const report = await pollAll(db, { adapters: fakeAdapters([nyPosting, torontoOnly]), now });
  expect(report[0]).toMatchObject({ newJobs: 2, queued: 1, skipped: 1 });
  expect(listJobs(db, { status: "queued" })[0].chosenLocation).toBe("NYC");
  expect(listJobs(db, { status: "skipped" })[0].statusReason).toContain("Canada");
  expect(listSources(db)[0]).toMatchObject({ etag: '"e1"', lastPolledAt: now.toISOString() });
});

test("same role in another city becomes duplicate-role", async () => {
  const db = openDb(":memory:");
  const other = mk({ listingId: "9", url: "https://acme.test/9", locations: ["Seattle, WA"] });
  const r = await pollAll(db, { adapters: fakeAdapters([nyPosting, other]), now });
  expect(r[0]).toMatchObject({ queued: 1, duplicates: 1 });
  expect(countByStatus(db)).toMatchObject({ queued: 1, "duplicate-role": 1 });
});

test("re-polling does not duplicate jobs; posting gone inactive closes a queued job", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const again = await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  expect(again[0]).toMatchObject({ newJobs: 0, closed: 0 });
  expect(listJobs(db, {})).toHaveLength(1);
  const r = await pollAll(db, { adapters: fakeAdapters([{ ...nyPosting, active: false }]), now });
  expect(r[0].closed).toBe(1);
  expect(countByStatus(db)).toMatchObject({ queued: 0, closed: 1 });
});

test("a posting the source no longer lists is closed, only for that source", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const elsewhere = mk({ listingId: "7", url: "https://other.test/7", company: "Gamma" });
  const r = await pollAll(db, { adapters: fakeAdapters([elsewhere]), now });
  expect(r[0].closed).toBe(1);
  expect(listJobs(db, { status: "closed" }).map(j => j.listingId)).toEqual(["1"]);
});

test("an empty successful fetch closes nothing and reports why", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const r = await pollAll(db, { adapters: fakeAdapters([], '"e2"'), now });
  expect(r[0]).toMatchObject({ fetched: 0, closed: 0, error: "source returned 0 postings; skipped closing" });
  expect(countByStatus(db)).toMatchObject({ queued: 1, closed: 0 });
});

test("a job matched by URL under a new listing id is not closed by the sweep", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const r = await pollAll(db, { adapters: fakeAdapters([{ ...nyPosting, listingId: "B" }]), now });
  expect(r[0]).toMatchObject({ newJobs: 0, closed: 0 });
  expect(countByStatus(db)).toMatchObject({ queued: 1, closed: 0 });
});

test("polling source Y leaves source X's queued job alone", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  addSource(db, { id: "y", kind: "readme-table", url: "https://y.test/R.md", enabled: true });
  setSourceEnabled(db, "simplify-summer2027", false);
  const yPosting = mk({ sourceId: "y", listingId: "y1", url: "https://y.test/1", company: "Delta" });
  const r = await pollAll(db, { adapters: fakeAdapters([yPosting]), now });
  expect(r.map(x => x.sourceId)).toEqual(["y"]);
  expect(listJobs(db, { status: "queued" }).map(j => j.sourceId).sort()).toEqual(["simplify-summer2027", "y"]);
  expect(countByStatus(db).closed).toBe(0);
});

test("submitted jobs are never re-queued or closed by later polls", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const job = listJobs(db, {})[0];
  setStatus(db, job.id, "submitted");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  await pollAll(db, { adapters: fakeAdapters([{ ...nyPosting, active: false }]), now });
  await pollAll(db, { adapters: fakeAdapters([mk({ listingId: "7", url: "https://other.test/7", company: "Gamma" })]), now });
  expect(listJobs(db, {}).find(j => j.listingId === "1")!.status).toBe("submitted");
});

test("fetch error is reported and changes nothing", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const r = await pollAll(db, { adapters: throwingAdapters(new Error("HTTP 502")), now });
  expect(r[0].error).toContain("502");
  expect(countByStatus(db).queued).toBe(1);
  expect(countByStatus(db).closed).toBe(0);
  expect(listSources(db)[0].etag).toBe('"e1"');
});

test("notModified skips processing and keeps etag", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const later = new Date("2026-10-28");
  const r = await pollAll(db, { adapters: adaptersOf(adapter(() => ({ notModified: true }))), now: later });
  expect(r[0]).toMatchObject({ fetched: 0, closed: 0 });
  expect(r[0].error).toBeUndefined();
  expect(countByStatus(db).queued).toBe(1);
  expect(listSources(db)[0]).toMatchObject({ etag: '"e1"', lastPolledAt: later.toISOString() });
});

test("disabled sources are skipped", async () => {
  const db = openDb(":memory:");
  setSourceEnabled(db, "simplify-summer2027", false);
  expect(await pollAll(db, { adapters: fakeAdapters([nyPosting]), now })).toEqual([]);
});
