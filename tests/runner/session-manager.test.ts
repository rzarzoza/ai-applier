import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { paths } from "../../src/paths.js";
import { launchChrome, SessionManager, type LaunchPersistent } from "../../src/runner/session-manager.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

/** A stub of Playwright's launchPersistentContext handing out contexts of a headless test browser. */
const stub = (fail?: (opts: Record<string, unknown>) => Error | null) => vi.fn<LaunchPersistent>(async (_dir, opts) => {
  const err = fail?.(opts as Record<string, unknown>);
  if (err) throw err;
  const ctx = await browser.newContext();
  await ctx.newPage(); // a persistent context starts with one blank tab
  return ctx;
});

test("the app's browser is the installed Google Chrome, headed, on the persistent profile, with the machine's own window, locale and timezone", async () => {
  const launch = stub();
  const manager = new SessionManager({ launchPersistent: launch });
  const a = await manager.open();
  const b = await manager.open();
  expect(launch).toHaveBeenCalledOnce();
  expect(launch).toHaveBeenCalledWith(paths.browserProfile, { channel: "chrome", headless: false, viewport: null });
  const opts = launch.mock.calls[0]![1] as Record<string, unknown>;
  for (const k of ["locale", "timezoneId", "userAgent", "args", "ignoreDefaultArgs"]) expect(opts).not.toHaveProperty(k);
  // One context for everything: the window's blank first tab is used, then each run gets its own tab.
  expect(a.page.context()).toBe(b.page.context());
  expect(a.page.context().pages()).toEqual([a.page, b.page]);
  await manager.close();
});

test("without Chrome installed it falls back to the bundled Chromium (headed) and says so", async () => {
  const launch = stub(o => (o.channel ? new Error(`Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app\nRun "npx playwright install chrome"`) : null));
  const warn = vi.fn();
  const ctx: BrowserContext = await launchChrome("/tmp/profile", { launch, warn });
  expect(launch.mock.calls.map(c => c[1])).toEqual([
    { channel: "chrome", headless: false, viewport: null },
    { headless: false, viewport: null },
  ]);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Google Chrome isn't installed.*bundled Chromium/));
  await ctx.close();
  // Any other failure (a locked profile...) is not hidden behind another browser.
  const locked = stub(() => new Error("ProcessSingleton: profile in use"));
  await expect(launchChrome("/tmp/profile", { launch: locked, warn })).rejects.toThrow(/profile in use/);
  expect(locked).toHaveBeenCalledOnce();
});

test("front brings a parked tab forward; the window's last tab is blanked, not closed, when its run is done", async () => {
  const manager = new SessionManager({ launchPersistent: stub() });
  const first = await manager.open();
  const second = await manager.open({ front: true });
  await second.page.setContent("<p>job</p>");
  expect(second.park!("job-1", { handler: {} as never, fields: [], resolutions: [], watch: [], notes: [] })).toBe(true);
  const front = vi.spyOn(second.page, "bringToFront");
  expect(await manager.front("job-1")).toBe(true);
  expect(front).toHaveBeenCalledOnce();
  expect(await manager.front("nope")).toBe(false);
  await first.close();
  expect(first.page.isClosed()).toBe(true);
  await manager.unpark("job-1");
  expect(second.page.isClosed()).toBe(false);
  expect(second.page.url()).toBe("about:blank");
  // The blank tab is the next run's.
  expect((await manager.open()).page).toBe(second.page);
  await manager.close();
});
