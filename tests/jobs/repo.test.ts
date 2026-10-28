import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { roleKey } from "../../src/jobs/role-key.js";
import { countByStatus, findLiveRole, getJob, hasSubmittedToCompany, incrementAttempts, listJobs, nextQueued, setAts, setChosenLocation, setStatus, submittedSince, upsertPosting } from "../../src/jobs/repo.js";
import type { Posting } from "../../src/sources/types.js";

const p = (o: Partial<Posting> = {}): Posting => ({ sourceId: "simplify-summer2027", listingId: "1", company: "Acme",
  title: "Software Engineer Intern", locations: ["NYC"], category: "Software", terms: ["Summer 2027"], degrees: [],
  sponsorship: null, url: "https://acme.test/job/1", datePosted: new Date("2026-10-20"), active: true, ...o });

test("roleKey ignores case, punctuation, season/year words and term order", () => {
  expect(roleKey("Acme", "Software Engineer Intern - Summer 2027", ["B", "A"]))
    .toBe(roleKey("ACME", "software engineer intern", ["a", "b"]));
  expect(roleKey("Acme", "Data Intern", [])).not.toBe(roleKey("Acme", "Software Intern", []));
});

test("upsert inserts once, unique on url_norm and (source, listing)", () => {
  const db = openDb(":memory:");
  const a = upsertPosting(db, p());
  expect(a).toMatchObject({ isNew: true, job: { status: "new", active: true, locations: ["NYC"], attempts: 0 } });
  expect(upsertPosting(db, p()).isNew).toBe(false);
  expect(upsertPosting(db, p({ listingId: "2", url: "https://ACME.test/job/1/?utm_source=x" })).isNew).toBe(false);
  expect(upsertPosting(db, p({ active: false })).job.active).toBe(false);
  expect(listJobs(db, {})).toHaveLength(1);
});

test("status, location, ats, attempts, counts, queue order and role lookup", () => {
  const db = openDb(":memory:");
  const old = upsertPosting(db, p({ listingId: "1", url: "https://a.test/1", datePosted: new Date("2026-10-01") })).job;
  const fresh = upsertPosting(db, p({ listingId: "2", url: "https://a.test/2", datePosted: new Date("2026-10-25"), title: "Other" })).job;
  setStatus(db, old.id, "queued"); setStatus(db, fresh.id, "queued");
  expect(nextQueued(db)!.id).toBe(fresh.id);
  setChosenLocation(db, fresh.id, "NYC"); setAts(db, fresh.id, "greenhouse"); incrementAttempts(db, fresh.id);
  expect(getJob(db, fresh.id)).toMatchObject({ chosenLocation: "NYC", ats: "greenhouse", attempts: 1 });
  expect(countByStatus(db)).toMatchObject({ queued: 2, closed: 0 });
  expect(listJobs(db, { status: "queued", limit: 1, offset: 1 }).map(j => j.id)).toEqual([old.id]);
  expect(findLiveRole(db, old.roleKey, old.id)).toBeNull();
  const twin = upsertPosting(db, p({ listingId: "3", url: "https://a.test/3" })).job;
  expect(findLiveRole(db, old.roleKey, twin.id)!.id).toBe(old.id);
  setStatus(db, old.id, "skipped", "x");
  expect(findLiveRole(db, old.roleKey, twin.id)).toBeNull();
});

test("submittedSince and hasSubmittedToCompany", () => {
  const db = openDb(":memory:");
  const j = upsertPosting(db, p()).job;
  expect(hasSubmittedToCompany(db, "acme")).toBe(false);
  setStatus(db, j.id, "submitted");
  expect(submittedSince(db, new Date(Date.now() - 60_000))).toBe(1);
  expect(submittedSince(db, new Date(Date.now() + 60_000))).toBe(0);
  expect(hasSubmittedToCompany(db, "ACME")).toBe(true);
});

test("hasSubmittedToCompany also counts applied-manually and possibly-sent applications", () => {
  const db = openDb(":memory:");
  const j = upsertPosting(db, p()).job;
  for (const [status, reason, expected] of [
    ["applied-manually", "Marked applied by you", true],
    ["needs-you", "Submission state unknown — check before retrying", true],
    ["needs-you", "1 question needs you", false],
    ["failed", "Submission state unknown", false],
    ["queued", null, false],
  ] as const) {
    setStatus(db, j.id, status, reason);
    expect(hasSubmittedToCompany(db, "acme"), `${status}: ${reason}`).toBe(expected);
  }
});

test("upsert records the posting's degrees, filling them in for rows stored without them", () => {
  const db = openDb(":memory:");
  const j = upsertPosting(db, p({ degrees: ["Bachelor's"] })).job;
  expect(j.degrees).toEqual(["Bachelor's"]);
  db.prepare("UPDATE jobs SET degrees = NULL WHERE id = ?").run(j.id);
  expect(getJob(db, j.id)!.degrees).toBeNull();
  expect(upsertPosting(db, p({ degrees: ["Master's"] })).job.degrees).toEqual(["Master's"]);
});
