import { expect, test } from "vitest";
import { getSettings } from "../../src/settings.js";
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
