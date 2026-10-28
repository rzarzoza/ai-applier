import { chromium, type BrowserContext, type Page } from "playwright";
import { paths } from "../paths.js";
import type { BrowserProvider, BrowserSession, ParkInfo } from "./browser.js";

/** A page a run left open for the dashboard's live view, with what the run knew about it. */
export interface Parked extends ParkInfo {
  jobId: string;
  page: Page;
  parkedAt: number;
  lastViewedAt: number;
}

export interface SessionManagerOptions {
  /** Starts the shared context every run and live view uses. Default: launchChrome at paths.browserProfile. */
  launch?: () => Promise<BrowserContext>;
  /** The Playwright call behind the default launch (tests stub it). */
  launchPersistent?: LaunchPersistent;
  /** Where the default launch reports falling back to the bundled Chromium. Default console.warn. */
  warn?: (msg: string) => void;
  /** How many pages may stay parked; parking one more closes the least recently viewed. Default 10. */
  cap?: number;
  now?: () => number;
  /**
   * Keeps the window open when its last tab is done with: that tab goes back to a blank page instead of closing (Chrome
   * would close the window, and the next run would open a new one). Default true.
   */
  keepLastTab?: boolean;
}

export type LaunchPersistent = (dir: string, opts: Parameters<typeof chromium.launchPersistentContext>[1]) => Promise<BrowserContext>;

/** The error Playwright gives when the requested browser channel is not installed. */
const MISSING_CHANNEL = /is not found at|not installed|executable doesn't exist|install chrome|no such file/i;

/**
 * Starts the user's installed Google Chrome, headed (a real, visible window), on the app's own persistent profile at
 * `dir`, so cookies and portal sessions persist between runs and restarts. The window keeps Chrome's own size, locale
 * and timezone (nothing is overridden). Without Chrome installed it falls back to Playwright's bundled Chromium, with a
 * warning. Never the user's everyday Chrome profile (Chrome can't share a profile with a running Chrome).
 */
export async function launchChrome(dir: string, opts: { launch?: LaunchPersistent; warn?: (msg: string) => void } = {}): Promise<BrowserContext> {
  const launch = opts.launch ?? ((d, o) => chromium.launchPersistentContext(d, o));
  const base = { headless: false, viewport: null } as const;
  try {
    return await launch(dir, { ...base, channel: "chrome" });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
    if (!MISSING_CHANNEL.test(err instanceof Error ? err.message : String(err))) throw err;
    (opts.warn ?? (m => console.warn(m)))(`Google Chrome isn't installed (${msg}); using Playwright's bundled Chromium instead`);
    return launch(dir, base);
  }
}

export const PARK_CAP = 10;

type Listener = (jobId: string, event: "parked" | "unparked") => void;

/**
 * The app's one browser: a single long-lived, visible Chrome window on the app's persistent profile (cookies and portal
 * sessions persist; nothing is cleared between jobs). Each run gets a tab in it, and a run that ends waiting on the user
 * parks its tab here instead of closing it, so the dashboard can show and drive it (see LiveService) and the user can
 * bring it to the front (front). At most `cap` tabs stay parked: parking another closes the least recently viewed one.
 */
export class SessionManager implements BrowserProvider {
  readonly keepsPages = true;
  private shared: Promise<BrowserContext> | null = null;
  private readonly parked = new Map<string, Parked & { close(): Promise<void> }>();
  /** Tabs given to runs (a blank tab not among them may be reused). */
  private readonly handedOut = new Set<Page>();
  private readonly listeners = new Set<Listener>();
  private readonly cap: number;
  private readonly now: () => number;

  constructor(private readonly opts: SessionManagerOptions = {}) {
    this.cap = opts.cap ?? PARK_CAP;
    this.now = opts.now ?? Date.now;
  }

  /** A new tab for a run (the window's first, still blank tab when nothing uses it yet); `front` brings it forward. */
  async open(opts: { front?: boolean } = {}): Promise<BrowserSession> {
    const ctx = await this.context();
    const blank = ctx.pages().find(p => !this.handedOut.has(p) && !p.isClosed() && p.url() === "about:blank");
    const page = blank ?? (await ctx.newPage());
    this.handedOut.add(page);
    page.once("close", () => this.handedOut.delete(page));
    if (opts.front) await page.bringToFront().catch(() => {});
    const close = () => this.closePage(page);
    return { page, close, park: (jobId, info) => this.park(jobId, page, close, info) };
  }

  /** Brings the job's parked tab to the front of the Chrome window. False when nothing is parked for it. */
  async front(jobId: string): Promise<boolean> {
    const p = this.get(jobId);
    if (!p) return false;
    this.touch(jobId);
    await p.page.bringToFront();
    return true;
  }

  /** The parked page of the job, if any. */
  get(jobId: string): Parked | undefined {
    const p = this.parked.get(jobId);
    return p && !p.page.isClosed() ? p : undefined;
  }

  isParked(jobId: string): boolean {
    return !!this.get(jobId);
  }

  parkedIds(): string[] {
    return [...this.parked.keys()].filter(id => this.isParked(id));
  }

  /** Marks the job's page as just viewed (it is the last to be evicted). */
  touch(jobId: string): void {
    const p = this.parked.get(jobId);
    if (p) p.lastViewedAt = this.now();
  }

  /** Called whenever a page is parked or unparked (closed). */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Closes the job's parked page, if any. */
  async unpark(jobId: string): Promise<void> {
    const p = this.parked.get(jobId);
    if (!p) return;
    this.parked.delete(jobId);
    this.emit(jobId, "unparked");
    await p.close().catch(() => {});
  }

  /** Closes every parked page whose job `keep` no longer allows (it was submitted, skipped, requeued...). */
  async sweep(keep: (jobId: string) => boolean): Promise<string[]> {
    const gone = [...this.parked.keys()].filter(id => !keep(id));
    for (const id of gone) await this.unpark(id);
    return gone;
  }

  /** Closes every parked page and the shared browser. */
  async close(): Promise<void> {
    for (const id of [...this.parked.keys()]) await this.unpark(id);
    const shared = this.shared;
    this.shared = null;
    if (shared) await shared.then(c => c.close(), () => {}).catch(() => {});
  }

  private park(jobId: string, page: Page, close: () => Promise<void>, info: ParkInfo): boolean {
    if (page.isClosed()) return false;
    const old = this.parked.get(jobId);
    if (old && old.page !== page) void this.unpark(jobId);
    while (this.parked.size >= this.cap) {
      const lru = [...this.parked.values()].filter(p => p.jobId !== jobId).sort((a, b) => a.lastViewedAt - b.lastViewedAt)[0];
      if (!lru) break;
      void this.unpark(lru.jobId);
    }
    const at = this.now();
    this.parked.set(jobId, { ...info, jobId, page, close, parkedAt: at, lastViewedAt: at });
    page.once("close", () => {
      if (this.parked.get(jobId)?.page !== page) return;
      this.parked.delete(jobId);
      this.emit(jobId, "unparked");
    });
    this.emit(jobId, "parked");
    return true;
  }

  /** Closes a run's tab; the window's last tab is blanked instead (see keepLastTab). */
  private async closePage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const others = page.context().pages().filter(p => p !== page && !p.isClosed());
    if ((this.opts.keepLastTab ?? true) && !others.length) {
      this.handedOut.delete(page);
      await page.goto("about:blank").catch(() => page.close().catch(() => {}));
      return;
    }
    await page.close().catch(() => {});
  }

  private emit(jobId: string, event: "parked" | "unparked") {
    for (const l of this.listeners) {
      try { l(jobId, event); } catch { /* a listener must never break parking */ }
    }
  }

  private context(): Promise<BrowserContext> {
    if (!this.shared) {
      const launching = (this.opts.launch ?? (() => launchChrome(paths.browserProfile, { launch: this.opts.launchPersistent, warn: this.opts.warn })))();
      this.shared = launching;
      launching.then(
        ctx => ctx.on("close", () => {
          if (this.shared !== launching) return;
          // The browser went away (crash, killed): every parked page went with it; the next run starts a new one.
          this.shared = null;
          for (const id of [...this.parked.keys()]) void this.unpark(id);
        }),
        () => { if (this.shared === launching) this.shared = null; },
      );
    }
    return this.shared;
  }
}
