import { expect, test } from "vitest";
import { getJson, getSettings, setJson } from "../../src/settings.js";
import { form, setupApp } from "./helpers.js";

const base = { reviewMode: "companies", reviewCompanies: "Acme, Globex", dailyLimit: "15", pollMinutes: "60", headless: "1", apiKey: "" };

test("POST /settings persists values and does not call setSecret without a key", async () => {
  const { db, app, secrets } = setupApp();
  const res = await app.request("/settings", form(base));
  expect(res.status).toBe(303);
  expect(getSettings(db)).toMatchObject({ reviewMode: "companies", reviewCompanies: ["Acme", "Globex"], dailyLimit: 15, pollMinutes: 60, headless: true, paused: false });
  expect(secrets.set).not.toHaveBeenCalled();
});

test("POST /settings saves a provided key via setSecret and never echoes it", async () => {
  const { app, secrets } = setupApp();
  await app.request("/settings", form({ ...base, apiKey: " sk-secret " }));
  expect(secrets.set).toHaveBeenCalledWith("anthropic-api-key", "sk-secret");
  secrets.get.mockResolvedValue("sk-secret");
  const html = await (await app.request("/settings")).text();
  expect(html).toContain("set ✓");
  expect(html).not.toContain("sk-secret");
  expect(html).toContain('type="password"');
});

test("GET /settings shows 'not set' when there is no key; invalid values are rejected", async () => {
  const { app, db } = setupApp();
  expect(await (await app.request("/settings")).text()).toContain("not set");
  expect((await app.request("/settings", form({ ...base, pollMinutes: "0" }))).status).toBe(400);
  expect((await app.request("/settings", form({ ...base, reviewMode: "bogus" }))).status).toBe(400);
  expect(getSettings(db).pollMinutes).toBe(30);
});

test("unchecked boxes turn headless and paused off; blank daily limit means no limit", async () => {
  const { db, app } = setupApp();
  await app.request("/settings", form({ ...base, paused: "1" }));
  expect(getSettings(db).paused).toBe(true);
  await app.request("/settings", form({ ...base, headless: "", dailyLimit: "" }));
  expect(getSettings(db)).toMatchObject({ paused: false, headless: false, dailyLimit: null });
});

test("GET /settings renders 'unknown' instead of failing when the Keychain read throws", async () => {
  const { app, secrets } = setupApp();
  secrets.get.mockRejectedValue(new Error("keychain locked"));
  const res = await app.request("/settings");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("unknown");
});

test("POST /settings still saves other settings and shows an error when the Keychain write throws", async () => {
  const { db, app, secrets } = setupApp();
  secrets.set.mockRejectedValue(new Error("keychain locked"));
  const res = await app.request("/settings", form({ ...base, pollMinutes: "45", apiKey: "sk-x" }));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Couldn&#39;t save the API key");
  expect(html).not.toContain("sk-x");
  expect(html).not.toContain("keychain locked");
  expect(getSettings(db).pollMinutes).toBe(45);
});

test("every dashboard page shows the paused banner only while paused", async () => {
  const { db, app } = setupApp();
  const { saveSettings } = await import("../../src/settings.js");
  saveSettings(db, { paused: true });
  for (const p of ["/inbox", "/applications", "/bank", "/profile", "/sources", "/settings"])
    expect(await (await app.request(p)).text()).toContain("Paused — nothing will be applied");
  saveSettings(db, { paused: false });
  expect(await (await app.request("/inbox")).text()).not.toContain("Paused — nothing will be applied");
});

test("a runner halt shows its reason in the banner until the user turns Paused off", async () => {
  const { db, app } = setupApp();
  const { haltRunner, getRunnerHalt } = await import("../../src/settings.js");
  haltRunner(db, "Anthropic rate limit reached — try again later");
  for (const p of ["/inbox", "/applications", "/bank", "/profile", "/sources", "/settings"])
    expect(await (await app.request(p)).text()).toContain("Paused: Anthropic rate limit reached — try again later");
  // Saving other settings while still paused keeps the reason.
  await app.request("/settings", form({ ...base, paused: "1" }));
  expect(getRunnerHalt(db)).not.toBeNull();
  await app.request("/settings", form(base));
  expect(getSettings(db).paused).toBe(false);
  expect(getRunnerHalt(db)).toBeNull();
  expect(await (await app.request("/inbox")).text()).not.toContain("Paused");
});

// --- tracker spreadsheet ---
const SA = JSON.stringify({ type: "service_account", client_email: "bot@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nSECRETKEY\n-----END PRIVATE KEY-----\n" });
const upload = (name: string, content: string, extra: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set(name, new File([content], "key.json", { type: "application/json" }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return { method: "POST", body: fd };
};

test("tracker URL is validated and stored under kv trackerSheetUrl", async () => {
  const { db, app } = setupApp();
  const bad = await app.request("/tracker/url", form({ url: "https://example.com/x" }));
  expect(bad.status).toBe(400);
  expect(await bad.text()).toContain("Google Sheet");
  const ok = await app.request("/tracker/url", form({ url: "https://docs.google.com/spreadsheets/d/abc123/edit" }));
  expect(ok.status).toBe(303);
  expect(getJson(db, "trackerSheetUrl", "")).toBe("https://docs.google.com/spreadsheets/d/abc123/edit");
  expect(await (await app.request("/settings")).text()).toContain("https://docs.google.com/spreadsheets/d/abc123/edit");
  await app.request("/tracker/url", form({ url: "" }));
  expect(getJson(db, "trackerSheetUrl", "x")).toBe("");
});

test("service-account key is stored in the secrets store, only client_email is shown", async () => {
  const { app, secrets } = setupApp();
  const res = await app.request("/tracker/key", upload("key", SA));
  expect(res.status).toBe(303);
  expect(secrets.set).toHaveBeenCalledWith("google-service-account", SA);
  secrets.get.mockResolvedValue(SA);
  const html = await (await app.request("/settings")).text();
  expect(html).toContain("bot@proj.iam.gserviceaccount.com");
  expect(html).not.toContain("SECRETKEY");
});

test("service-account key upload rejects bad files and Keychain errors without a 500", async () => {
  const { app, secrets } = setupApp();
  for (const bad of ["not json", JSON.stringify({ type: "user", client_email: "a", private_key: "b" }), JSON.stringify({ type: "service_account", client_email: "a" }), "x".repeat(70_000)]) {
    const r = await app.request("/tracker/key", upload("key", bad));
    expect(r.status).toBe(400);
  }
  expect((await app.request("/tracker/key", form({}))).status).toBe(400);
  expect(secrets.set).not.toHaveBeenCalled();
  secrets.set.mockRejectedValue(new Error("keychain locked"));
  const r = await app.request("/tracker/key", upload("key", SA));
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain("Couldn&#39;t save the key to the Keychain");
  expect(html).not.toContain("keychain locked");
  expect(html).not.toContain("SECRETKEY");
});

test("Settings renders when the key is unreadable or malformed", async () => {
  const { app, secrets } = setupApp();
  secrets.get.mockResolvedValue("garbage");
  expect((await app.request("/settings")).status).toBe(200);
});

test("POST /tracker/sync triggers a sync; GET /tracker.csv regenerates and downloads", async () => {
  const { app, trackerSync } = setupApp();
  const res = await app.request("/tracker/sync", { method: "POST" });
  expect(res.status).toBe(303);
  expect(trackerSync).toHaveBeenCalledTimes(1);
  const csv = await app.request("/tracker.csv");
  expect(csv.headers.get("content-type")).toContain("text/csv");
  expect(csv.headers.get("content-disposition")).toBe('attachment; filename="applications.csv"');
  expect(await csv.text()).toContain("Date applied,Company,Job title");
});

test("tracker section shows last sync time and error", async () => {
  const { db, app } = setupApp();
  setJson(db, "trackerSync", { lastSyncAt: "2026-10-28T20:00:00.000Z", lastError: "403 PERMISSION_DENIED" });
  const html = await (await app.request("/settings")).text();
  expect(html).toContain("403 PERMISSION_DENIED");
  expect(html).toContain("/tracker.csv");
});

test("errors from the Keychain that echo the secret never reach the page", async () => {
  const { app, secrets } = setupApp();
  secrets.set.mockImplementation(async (_n: string, v: string) => { throw new Error(`Command failed: security add-generic-password -w ${v}`); });
  const a = await (await app.request("/tracker/key", upload("key", SA))).text();
  expect(a).not.toContain("SECRETKEY");
  expect(a).not.toContain("Command failed");
  const b = await (await app.request("/settings", form({ ...base, apiKey: "sk-topsecret" }))).text();
  expect(b).not.toContain("sk-topsecret");
});
