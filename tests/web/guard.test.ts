import { expect, test, vi } from "vitest";
import { openDb } from "../../src/db/db.js";
import { getSettings, saveSettings } from "../../src/settings.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";

function guarded() {
  const db = openDb(":memory:");
  const app = createApp({ db, llm: new FakeLlm(), runInteractive: vi.fn(), runReviewed: vi.fn(), pollNow: vi.fn(), localPort: () => 4310 });
  return { db, app };
}
const get = (host?: string) => new Request("http://127.0.0.1:4310/inbox", { headers: host ? { host } : {} });
const post = (headers: Record<string, string>) => new Request("http://127.0.0.1:4310/settings", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams({ reviewMode: "all", pollMinutes: "30" }),
});

test("only requests addressed to the dashboard's own host and port are served", async () => {
  const { app } = guarded();
  expect((await app.request(get("127.0.0.1:4310"))).status).toBe(200);
  expect((await app.request(get("localhost:4310"))).status).toBe(200);
  for (const host of ["evil.test", "evil.test:4310", "127.0.0.1:9999", "127.0.0.1"]) {
    expect((await app.request(get(host))).status, host).toBe(403);
  }
  expect((await app.request(get())).status).toBe(403);
});

test("changes are accepted only from the dashboard's own origin", async () => {
  const { db, app } = guarded();
  saveSettings(db, { reviewMode: "off" });
  for (const origin of ["http://evil.test", "http://127.0.0.1:9999", "https://127.0.0.1:4310", "null"]) {
    expect((await app.request(post({ host: "127.0.0.1:4310", origin }))).status, origin).toBe(403);
  }
  expect((await app.request(post({ host: "127.0.0.1:4310" }))).status).toBe(403); // no Origin
  expect(getSettings(db).reviewMode).toBe("off");
  // The dashboard's own forms and htmx requests carry its origin.
  expect((await app.request(post({ host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" }))).status).toBe(303);
  expect((await app.request(post({ host: "localhost:4310", origin: "http://localhost:4310", "hx-request": "true" }))).status).toBe(303);
  expect(getSettings(db).reviewMode).toBe("all");
});
