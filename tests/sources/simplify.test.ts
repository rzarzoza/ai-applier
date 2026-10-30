import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseSimplifyListings, simplifyAdapter } from "../../src/sources/simplify.js";
import type { SourceConfig } from "../../src/sources/types.js";

const sampleJson = JSON.parse(readFileSync("tests/fixtures/simplify/listings-sample.json", "utf8"));
const cfg: SourceConfig = { id: "s", kind: "simplify-json", url: "https://x.test/l.json", enabled: true, etag: null, lastPolledAt: null };

test("parseSimplifyListings keeps active+visible and maps fields", () => {
  const ps = parseSimplifyListings(sampleJson, "simplify-summer2027");
  expect(ps.length).toBeGreaterThan(0);
  expect(ps.every(p => p.active)).toBe(true);
  expect(ps.find(p => p.listingId === "https://saputo.wd5.myworkdayjobs.com/saputo_external_careers/job/Montral-QC/IT-Analytics-Intern---Finance---HR-Solutions_JR62566")).toBeUndefined();
  const lever = ps.find(p => p.url.includes("lever.co"))!;
  expect(lever.url).not.toContain("simplify.jobs");
  expect(lever.datePosted).toBeInstanceOf(Date);
  expect(lever.sourceId).toBe("simplify-summer2027");
  expect(ps.some(p => p.url.includes("simplify.jobs"))).toBe(false);
  expect(ps.some(p => p.locations.includes("Toronto, ON, Canada"))).toBe(true);
});

test("parseSimplifyListings rejects non-array input", () => {
  expect(() => parseSimplifyListings({}, "x")).toThrow();
});

test("simplifyAdapter parses 200, sends If-None-Match, 304 and 500", async () => {
  let seen: Headers | undefined;
  const ok = (async (_u: unknown, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify(sampleJson), { status: 200, headers: { etag: '"abc"' } });
  }) as typeof fetch;
  const r = await simplifyAdapter.fetch({ ...cfg, etag: '"old"' }, ok);
  expect(seen!.get("if-none-match")).toBe('"old"');
  expect(r.notModified).toBe(false);
  if (!r.notModified) { expect(r.etag).toBe('"abc"'); expect(r.postings.length).toBeGreaterThan(0); }

  const nm = (async () => new Response(null, { status: 304 })) as typeof fetch;
  expect(await simplifyAdapter.fetch(cfg, nm)).toEqual({ notModified: true });

  const bad = (async () => new Response("no", { status: 500 })) as typeof fetch;
  await expect(simplifyAdapter.fetch(cfg, bad)).rejects.toThrow();
  const junk = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
  await expect(simplifyAdapter.fetch(cfg, junk)).rejects.toThrow();
});
