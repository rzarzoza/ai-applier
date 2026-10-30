import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Browser } from "playwright";
import { addNeedsYou, getOverrides } from "../../src/answers/bank.js";
import { getJob, setStatus, UNKNOWN_SUBMISSION } from "../../src/jobs/repo.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { center, launchBrowser, liveSetup, until } from "../helpers/live-setup.js";

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser.close(); });

let s: ReturnType<typeof liveSetup>;
let app: ReturnType<typeof createApp>;
let runHandFinish: ReturnType<typeof vi.fn<(jobId: string) => void>>;
let runInteractive: ReturnType<typeof vi.fn<(jobId: string) => void>>;
const requested: string[] = [];
beforeEach(() => {
  s = liveSetup(browser);
  runHandFinish = vi.fn<(jobId: string) => void>();
  runInteractive = vi.fn<(jobId: string) => void>();
  requested.length = 0;
  app = createApp({ db: s.db, llm: new FakeLlm(), runInteractive, runReviewed: vi.fn(), runHandFinish, pollNow: vi.fn(), live: s.live, requestedRuns: () => requested });
});
afterEach(async () => { await s.close(); });

const input = (jobId: string, events: unknown[], headers: Record<string, string> = {}) =>
  app.request(`/live/${jobId}/input`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ events }) });

/** Reads a Server-Sent Events response: `next(type)` resolves with the data of the next event of that type. */
function events(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    reader,
    async next(type: string): Promise<string> {
      for (;;) {
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: (.*)$/m.exec(block)?.[1] === type) return block.replace(/^event: .*\n/m, "").replace(/^data: /gm, "");
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`the stream ended before a ${type} event`);
        buf += decoder.decode(value, { stream: true });
      }
    },
  };
}

test("the stream sends the parked page's frames, and the screencast stops once nobody watches", async () => {
  const j = await s.needsYouJob();
  const res = await app.request(`/live/${j.id}/stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const stream = events(res);
  const frame = JSON.parse(await stream.next("frame")) as { d: string; w: number; h: number };
  expect(Buffer.from(frame.d, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // a JPEG
  expect(frame.w).toBeGreaterThan(0);
  expect(frame.h).toBeGreaterThan(0);
  expect(s.live.viewerCount(j.id)).toBe(1);
  expect(s.live.isCasting(j.id)).toBe(true);
  await stream.reader.cancel();
  await until(() => s.live.viewerCount(j.id) === 0 && !s.live.isCasting(j.id));
});

test("a page that goes away ends its viewers' streams with a status event", async () => {
  const j = await s.needsYouJob();
  const res = await app.request(`/live/${j.id}/stream`);
  const stream = events(res);
  await stream.next("frame");
  const closing = stream.next("status");
  await s.live.close(j.id);
  expect(JSON.parse(await closing)).toEqual({ status: "closed" });
  await until(() => !s.live.isCasting(j.id));
});

test("input clicks into a field and types text into the parked page, then it is saved as the job's value", async () => {
  const j = await s.needsYouJob();
  const page = s.manager.get(j.id)!.page;
  const phone = await center(page, "#phone");
  expect((await input(j.id, [{ t: "move", ...phone }, { t: "down", ...phone, button: "left", clicks: 1 }, { t: "up", ...phone, button: "left", clicks: 1 }])).status).toBe(204);
  expect((await input(j.id, [{ t: "keydown", key: "5" }, { t: "keyup", key: "5" }, { t: "text", text: "550001111" }])).status).toBe(204);
  expect(await page.locator("#phone").inputValue()).toBe("5550001111");
  await s.live.tick(j.id);
  expect(getOverrides(s.db, j.id).Phone).toEqual({ type: "text", text: "5550001111" });
});

test("live endpoints only serve jobs waiting on the user or their review", async () => {
  const j = await s.needsYouJob();
  expect((await input("nope", [])).status).toBe(404);
  expect((await app.request("/live/nope/stream")).status).toBe(404);
  setStatus(s.db, j.id, "queued");
  for (const res of [
    await input(j.id, [{ t: "text", text: "x" }]),
    await app.request(`/live/${j.id}/stream`),
    await app.request(`/live/${j.id}/refill`, { method: "POST" }),
    await app.request(`/live/${j.id}/rebuild`, { method: "POST" }),
    await app.request(`/live/${j.id}/pop-out`, { method: "POST" }),
  ]) expect(res.status).toBe(409);
  setStatus(s.db, j.id, "needs-you", UNKNOWN_SUBMISSION);
  expect((await input(j.id, [{ t: "text", text: "x" }])).status).toBe(409);
  setStatus(s.db, j.id, "needs-you", "2 questions need you");
  expect((await input(j.id, [{ t: "nonsense" }])).status).toBe(400);
  expect((await app.request(`/live/${j.id}/stream`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
});

test("with the Host/Origin guard on, input from another site is refused", async () => {
  const j = await s.needsYouJob();
  const guarded = createApp({ db: s.db, llm: new FakeLlm(), runInteractive, runReviewed: vi.fn(), runHandFinish, pollNow: vi.fn(), live: s.live, localPort: () => 4310 });
  const post = (origin: string) => guarded.request(new Request(`http://127.0.0.1:4310/live/${j.id}/input`, {
    method: "POST", headers: { host: "127.0.0.1:4310", origin, "content-type": "application/json" }, body: JSON.stringify({ events: [{ t: "text", text: "1" }] }),
  }));
  expect((await post("http://evil.test")).status).toBe(403);
  expect(await s.manager.get(j.id)!.page.locator("#phone").inputValue()).toBe("");
  expect((await post("http://127.0.0.1:4310")).status).toBe(204);
});

test("the job page shows the live panel when its page is parked, and asks for a rebuild when it isn't", async () => {
  const j = await s.needsYouJob();
  let html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).toContain(`data-live="${j.id}"`);
  expect(html).toContain("Refill from my answers");
  expect(html).toContain("Pop out");
  expect(html).not.toContain(`hx-post="/applications/${j.id}/hand-finish"`);
  await s.live.close(j.id);
  html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).toContain(`hx-post="/live/${j.id}/rebuild" hx-trigger="load"`);
  expect(html).toContain("Rebuilding your application…");
  const res = await app.request(`/live/${j.id}/rebuild`, { method: "POST" });
  expect(await res.text()).toContain(`hx-get="/live/${j.id}/panel" hx-trigger="every 2s"`);
  await until(() => s.manager.isParked(j.id));
  expect(await (await app.request(`/live/${j.id}/panel`)).text()).toContain(`data-live="${j.id}"`);
  // A job the live view can't show keeps the page without the panel.
  setStatus(s.db, j.id, "failed", "Boom");
  html = await (await app.request(`/applications/${j.id}`)).text();
  expect(html).not.toContain("data-live=");
  expect(html).not.toContain("/live/");
});

test("Pop out brings the parked tab to the front (no second browser); Close just closes it", async () => {
  const j = await s.needsYouJob();
  const page = s.manager.get(j.id)!.page;
  const front = vi.spyOn(page, "bringToFront");
  const res = await app.request(`/live/${j.id}/pop-out`, { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Brought to the front of the Chrome window.");
  expect(front).toHaveBeenCalledOnce();
  expect(page.isClosed()).toBe(false);
  expect(runHandFinish).not.toHaveBeenCalled();
  expect(runInteractive).not.toHaveBeenCalled();
  // Do it now and Open & finish bring the parked tab forward too, instead of opening the job again.
  setStatus(s.db, j.id, "needs-you", "CAPTCHA");
  addNeedsYou(s.db, { jobId: j.id, kind: "captcha", message: "Mini Co: solve the CAPTCHA" });
  expect(await (await app.request(`/needs-you/${j.id}/do-it-now`, { method: "POST" })).text()).toContain("Brought to the front");
  expect(front).toHaveBeenCalledTimes(2);
  expect(runInteractive).not.toHaveBeenCalled();
  const html = await (await app.request(`/live/${j.id}/close`, { method: "POST" })).text();
  expect(html).toContain("Open here");
  expect(s.manager.isParked(j.id)).toBe(false);
  expect(getJob(s.db, j.id)!.status).toBe("needs-you");
  // Nothing parked: Pop out has nothing to show, and Do it now opens the job again.
  expect((await app.request(`/live/${j.id}/pop-out`, { method: "POST" })).status).toBe(409);
  await app.request(`/needs-you/${j.id}/do-it-now`, { method: "POST" });
  expect(runInteractive).toHaveBeenCalledWith(j.id);
});

test("refill puts the user's values back and attach-resume attaches the profile's resume", async () => {
  const j = await s.needsYouJob();
  const page = s.manager.get(j.id)!.page;
  await page.locator("#first").fill("");
  const res = await app.request(`/live/${j.id}/refill`, { method: "POST" });
  expect(await res.text()).toMatch(/Filled \d+ fields from your answers/);
  expect(await page.locator("#first").inputValue()).toBe("Luis");
  // No resume in this profile's data dir yet, and no file upload on this form.
  expect(await (await app.request(`/live/${j.id}/attach-resume`, { method: "POST" })).text()).toContain("attach your resume: upload one in");
});

test("Home and the Inbox send needs-you jobs to the live panel and mark the ones open in the app", async () => {
  const j = await s.needsYouJob();
  const home = await (await app.request("/home/lists")).text();
  expect(home).toContain(`href="/applications/${j.id}#live-panel">Open &amp; finish</a>`);
  expect(home).toContain("Open in app");
  await s.live.close(j.id);
  expect(await (await app.request("/home/lists")).text()).not.toContain("Open in app");
});

test("a failed rebuild shows why with a Retry button, and the status endpoint reports it", async () => {
  const j = s.addJob("https://mini-ats.test/blocked");
  s.markNeedsYou(j);
  const res = await app.request(`/live/${j.id}/rebuild`, { method: "POST" });
  expect(await res.text()).toContain("Rebuilding your application…");
  expect(await (await app.request(`/live/${j.id}/status`)).json()).toMatchObject({ kind: "rebuilding", elapsedMs: expect.any(Number) });
  await until(() => !s.live.rebuildState(j.id).rebuilding);
  expect(await (await app.request(`/live/${j.id}/status`)).json()).toEqual({ kind: "error", error: expect.stringMatching(/Blocked/) });
  const panel = await (await app.request(`/live/${j.id}/panel`)).text();
  expect(panel).toContain("open the application here.");
  expect(panel).toMatch(/Blocked/);
  expect(panel).toMatch(/hx-post="\/live\/[^"]+\/rebuild"[^>]*>\s*Retry\s*</);
  expect(panel).not.toContain("hx-trigger=\"every 2s\"");
  expect((await app.request("/live/nope/status")).status).toBe(404);
});
