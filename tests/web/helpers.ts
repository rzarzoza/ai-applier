import { vi } from "vitest";
import { openDb } from "../../src/db/db.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";

export function setupApp() {
  const db = openDb(":memory:");
  const llm = new FakeLlm();
  const pollNow = vi.fn();
  const secrets = { get: vi.fn().mockResolvedValue(null as string | null), set: vi.fn().mockResolvedValue(undefined) };
  const trackerSync = vi.fn().mockResolvedValue({ csv: true, sheet: "skipped" });
  const app = createApp({ db, llm, runInteractive: vi.fn(), runReviewed: vi.fn(), pollNow, secrets, syncTracker: trackerSync });
  return { db, llm, app, pollNow, secrets, trackerSync };
}

export const form = (o: Record<string, string>) => ({
  method: "POST", body: new URLSearchParams(o), headers: { "content-type": "application/x-www-form-urlencoded" },
});
