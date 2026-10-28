import { expect, test, vi } from "vitest";
import { googleSheetsClient, spreadsheetIdFromUrl } from "../../src/tracker/sheets.js";

test("spreadsheetIdFromUrl", () => {
  expect(spreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/abc123/edit#gid=0")).toBe("abc123");
  expect(spreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/a-b_C9")).toBe("a-b_C9");
  expect(spreadsheetIdFromUrl("https://example.com/foo")).toBeNull();
  expect(spreadsheetIdFromUrl("not a url")).toBeNull();
});

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("replaceTab creates a missing tab, clears it, then writes RAW values", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    if (url.includes("?fields=")) return respond({ sheets: [{ properties: { title: "Other" } }] });
    return respond({});
  });
  const client = googleSheetsClient("{}", { fetch: fetchFake as unknown as typeof fetch, token: async () => "tok" });
  await client.replaceTab("sid", "Applications", [["a", "b"], ["1", "2"]]);
  expect(calls.map(c => `${c.method} ${c.url.replace("https://sheets.googleapis.com/v4/spreadsheets/", "")}`)).toEqual([
    "GET sid?fields=sheets.properties.title",
    "POST sid:batchUpdate",
    "POST sid/values/Applications:clear",
    "PUT sid/values/Applications!A1?valueInputOption=RAW",
  ]);
  expect(calls[1]!.body).toEqual({ requests: [{ addSheet: { properties: { title: "Applications" } } }] });
  expect(calls[3]!.body).toEqual({ range: "Applications!A1", majorDimension: "ROWS", values: [["a", "b"], ["1", "2"]] });
});

test("replaceTab skips addSheet when the tab exists and surfaces API errors", async () => {
  const urls: string[] = [];
  const ok = vi.fn(async (url: string) => { urls.push(url); return url.includes("?fields=") ? respond({ sheets: [{ properties: { title: "Applications" } }] }) : respond({}); });
  await googleSheetsClient("{}", { fetch: ok as unknown as typeof fetch, token: async () => "t" }).replaceTab("s", "Applications", []);
  expect(urls.some(u => u.endsWith(":batchUpdate"))).toBe(false);

  const denied = vi.fn(async () => respond({ error: { code: 403, status: "PERMISSION_DENIED", message: "no access" } }, 403));
  await expect(googleSheetsClient("{}", { fetch: denied as unknown as typeof fetch, token: async () => "t" }).replaceTab("s", "Applications", []))
    .rejects.toThrow(/403.*PERMISSION_DENIED/);
});
