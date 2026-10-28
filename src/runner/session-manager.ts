import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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
  /** Starts the shared, headless context every run and live view uses. Default: persistent Chromium at paths.browserProfile. */
  launch?: () => Promise<BrowserContext>;
  /** Starts the browser behind a visible ("Pop out") window. Default: a headed Chromium. */
  launchVisible?: () => Promise<Browser>;
  /** How many pages may stay parked; parking one more closes the least recently viewed. Default 10. */
  cap?: number;
  now?: () => number;
}

export const PARK_CAP = 10;

type Listener = (jobId: string, event: "parked" | "unparked") => void;

/**
 * The app's one browser. Runs get pages in a single long-lived headless context (cookies and portal sessions persist in
 * the profile directory), and a run that ends waiting on the user parks its page here instead of closing it, so the
 * dashboard can show and drive it (see LiveService). At most `cap` pages stay parked: parking another closes the least
 * recently viewed one. Visible windows (Pop out, Do it now) open in a separate headed browser seeded with the shared
 * context's cookies, which are copied back when the window is done.
 */
export class SessionManager implements BrowserProvider {
  readonly keepsPages = true;
  private shared: Promise<BrowserContext> | null = null;
  private readonly parked = new Map<string, Parked & { close(): Promise<void> }>();
  private readonly listeners = new Set<Listener>();
  private readonly cap: number;
  private readonly now: () => number;

  constructor(private readonly opts: SessionManagerOptions = {}) {
    this.cap = opts.cap ?? PARK_CAP;
    this.now = opts.now ?? Date.now;
  }

  async open({ headless }: { headless: boolean }): Promise<BrowserSession> {
    if (!headless) return this.openVisible();
    const page = await (await this.context()).newPage();
    const close = () => page.close().catch(() => {});
    return { page, close, park: (jobId, info) => this.park(jobId, page, close, info) };
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

  private emit(jobId: string, event: "parked" | "unparked") {
    for (const l of this.listeners) {
      try { l(jobId, event); } catch { /* a listener must never break parking */ }
    }
  }

  private context(): Promise<BrowserContext> {
    if (!this.shared) {
      const launching = (this.opts.launch ?? (() => chromium.launchPersistentContext(paths.browserProfile, { headless: true })))();
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

  /** A visible window in its own browser, with the shared context's cookies; they are copied back once it is done. */
  private async openVisible(): Promise<BrowserSession> {
    const shared = await this.context().catch(() => null);
    const storageState = shared ? await shared.storageState().catch(() => undefined) : undefined;
    const browser = await (this.opts.launchVisible ?? (() => chromium.launch({ headless: false })))();
    try {
      const ctx = await browser.newContext({ storageState, viewport: null });
      const page = await ctx.newPage();
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          const live = this.shared && (await this.shared);
          if (live) await live.addCookies((await ctx.storageState()).cookies);
        } catch { /* the cookies are a convenience */ }
        await browser.close().catch(() => {});
      };
      return { page, close, park: (jobId, info) => this.park(jobId, page, close, info) };
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
}
