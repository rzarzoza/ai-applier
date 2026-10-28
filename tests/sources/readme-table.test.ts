import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseReadmeTable, readmeTableAdapter } from "../../src/sources/readme-table.js";
import type { SourceConfig } from "../../src/sources/types.js";

const simplifyReadme = readFileSync("tests/fixtures/readme/simplify-readme-sample.md", "utf8");
const pipeTable = readFileSync("tests/fixtures/readme/pipe-table.md", "utf8");
const now = new Date("2026-10-27T00:00:00Z");

test("parseReadmeTable reads HTML rows, inherits company on ↳, skips simplify links", () => {
  const ps = parseReadmeTable(simplifyReadme, "x", now);
  expect(ps[0].url).toMatch(/jobs\.lever\.co/);
  expect(ps[0].company).toBe("Commonwealth Fusion Systems");
  const child = ps.find(p => p.title === "Software Engineer Intern" && p.locations.includes("Austin, TX"))!;
  expect(child.company).toBe("Visa");
  expect(ps.some(p => p.url.includes("simplify.jobs"))).toBe(false);
  expect(ps.find(p => p.company === "Amazon")!.locations).toEqual(["Seattle, WA", "East Palo Alto, CA"]);
  expect(ps[0].datePosted.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  expect(ps[0].listingId).toBe("https://jobs.lever.co/cfsenergy/912d6878-25dd-4bdc-8df8-8f7002999619/apply");
});

test("parseReadmeTable drops closed (🔒) and link-less rows", () => {
  const html = `<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead><tbody>
<tr><td>A</td><td>R</td><td>X</td><td>🔒</td><td>1d</td></tr>
<tr><td>B</td><td>R</td><td>X</td><td><a href="https://b.test/j">Apply</a> 🔒</td><td>1d</td></tr>
<tr><td>C</td><td>R</td><td>X</td><td><a href="https://simplify.jobs/p/1">S</a></td><td>1d</td></tr>
<tr><td>D</td><td>R</td><td>X</td><td><a href="https://d.test/j">Apply</a></td><td>3d</td></tr></tbody></table>`;
  const ps = parseReadmeTable(html, "x", now);
  expect(ps.map(p => p.company)).toEqual(["D"]);
  expect(ps[0].datePosted.toISOString()).toBe("2026-10-24T00:00:00.000Z");
});

test("parseReadmeTable reads markdown pipe tables", () => {
  const ps = parseReadmeTable(pipeTable, "x", new Date("2026-10-27T00:00:00Z"));
  expect(ps.length).toBe(3);
  expect(ps[0].listingId).toBe("https://boards.greenhouse.io/acme/jobs/123");
  expect(ps[0].datePosted.toISOString().slice(0, 10)).toBe("2026-10-20");
  expect(ps[1].locations).toEqual(["Remote", "New York, NY"]);
  expect(ps[2].url).toContain("myworkdayjobs.com");
  expect(ps[2].datePosted.toISOString().slice(0, 10)).toBe("2026-08-27");
});

test("readmeTableAdapter fetches text and honours 304", async () => {
  const cfg: SourceConfig = { id: "s", kind: "readme-table", url: "https://x.test/R.md", enabled: true, etag: '"e"', lastPolledAt: null };
  const ok = (async () => new Response(pipeTable, { status: 200, headers: { etag: '"n"' } })) as typeof fetch;
  const r = await readmeTableAdapter.fetch(cfg, ok);
  expect(r.notModified).toBe(false);
  if (!r.notModified) expect(r.postings.length).toBe(3);
  expect(await readmeTableAdapter.fetch(cfg, (async () => new Response(null, { status: 304 })) as typeof fetch)).toEqual({ notModified: true });
  await expect(readmeTableAdapter.fetch(cfg, (async () => new Response("x", { status: 404 })) as typeof fetch)).rejects.toThrow();
});
