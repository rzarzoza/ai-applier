import { expect, test } from "vitest";
import { isSimplifyHost, normalizeUrl } from "../../src/sources/normalize.js";

test("normalizeUrl strips tracking params only", () => {
  expect(normalizeUrl("https://Jobs.Lever.co/palantir/abc/apply?utm_source=Simplify&ref=Simplify"))
    .toBe("https://jobs.lever.co/palantir/abc/apply");
  expect(normalizeUrl("https://www.psiquantum.com/apply?gh_jid=7761881003&utm_source=x"))
    .toBe("https://www.psiquantum.com/apply?gh_jid=7761881003");
});

test("normalizeUrl drops source param and trailing slash", () => {
  expect(normalizeUrl("https://example.com/jobs/?source=x&id=1")).toBe("https://example.com/jobs?id=1");
  expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
});

test("isSimplifyHost matches simplify.jobs and subdomains only", () => {
  expect(isSimplifyHost("https://simplify.jobs/p/abc")).toBe(true);
  expect(isSimplifyHost("https://www.Simplify.jobs/c/x")).toBe(true);
  expect(isSimplifyHost("https://notsimplify.jobs/x")).toBe(false);
  expect(isSimplifyHost("https://jobs.lever.co/simplify.jobs")).toBe(false);
  expect(isSimplifyHost("not a url")).toBe(false);
});
