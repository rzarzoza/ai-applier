import { existsSync } from "node:fs";
import type { CDPSession, Frame, Page } from "playwright";
import { normalizeLabel } from "../answers/classify.js";
import { getOverrides, resolveNeedsYouForJob, setOverride } from "../answers/bank.js";
import type { SubmitOutcome } from "../ats/types.js";
import type { Db } from "../db/db.js";
import { inPage } from "../forms/in-page.js";
import type { FieldAnswer, FieldSpec } from "../forms/types.js";
import { canOpenLive, getJob, setStatus } from "../jobs/repo.js";
import { paths } from "../paths.js";
import { holds, isEmpty, recordLiveSubmission, withTimeout } from "./runner.js";
import type { Parked, SessionManager } from "./session-manager.js";

/** What a live view's stream carries: a screen frame (base64 JPEG and its size in page pixels), the page's address, or the end. */
export type LiveEvent =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "meta"; url: string; title: string }
  | { type: "status"; status: "submitted" | "closed" | "applied-manually" };

/** One input the dashboard forwards to a parked page. Coordinates are page (CSS) pixels of the viewport. */
export type LiveInput =
  | { t: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "keydown" | "keyup"; key: string }
  | { t: "text"; text: string };

export interface LiveDeps {
  db: Db;
  manager: SessionManager;
  /** Called after a submission made in the live view was recorded (e.g. to sync the tracker). */
  onSubmitted?(jobId: string): void;
  /** Starts a rebuild of the job's page through the run queue; resolves once the run ended. */
  runRebuild(jobId: string): Promise<void>;
  /** How often a viewed page's fields are saved and its outcome checked. Default 3s. */
  pollMs?: number;
  /** How long after the last input a page is still watched with nobody viewing it. Default 2 minutes. */
  idleMs?: number;
  /** The resume a file chooser of a parked page gets. Default paths.resume. */
  resumePath?(): string;
}

const POLL_MS = 3_000;
const IDLE_MS = 120_000;
const MAX_WIDTH = 1280;
const BUTTONS = new Set(["left", "right", "middle"]);
const CHOICE_KINDS = new Set<FieldSpec["kind"]>(["select", "radio", "combobox"]);

type Viewer = (e: LiveEvent) => void;
type Captured = Map<string, string | string[] | boolean>;

/**
 * Runs the dashboard's live view of parked pages (see SessionManager): streams a page's screen to its viewers (CDP
 * screencast, started with the first viewer and stopped with the last), forwards their mouse and keyboard to it, and,
 * while it is viewed (and for a while after the last input), saves what the user typed into it as the job's per-job
 * values every few seconds (so a rebuild restores it) and checks whether the site confirmed a submission: the app never
 * clicks submit on a parked page, the user does.
 */
export class LiveService {
  private readonly viewers = new Map<string, Set<Viewer>>();
  private readonly casts = new Map<string, Promise<CDPSession | null>>();
  private readonly lastFrame = new Map<string, Extract<LiveEvent, { type: "frame" }>>();
  private readonly watchers = new Map<string, { timer: ReturnType<typeof setTimeout> | null; lastInput: number; busy: Promise<void> | null }>();
  private readonly captured = new Map<string, { values: Captured; saved: Map<string, string> }>();
  private readonly inputs = new Map<string, Promise<void>>();
  private readonly rebuilding = new Map<string, Promise<void>>();
  private readonly rebuildErrors = new Map<string, string>();
  private readonly offChange: () => void;
  private stopped = false;

  constructor(private readonly deps: LiveDeps) {
    this.offChange = deps.manager.onChange((jobId, event) => {
      if (event === "parked") this.prepare(jobId);
      else this.closed(jobId);
    });
  }

  isParked(jobId: string): boolean {
    return this.deps.manager.isParked(jobId);
  }

  parkedIds(): string[] {
    return this.deps.manager.parkedIds();
  }

  /** Whether a rebuild of the job is queued or running, and why the last one failed (cleared by the next). */
  rebuildState(jobId: string): { rebuilding: boolean; error: string | null } {
    return { rebuilding: this.rebuilding.has(jobId), error: this.rebuildErrors.get(jobId) ?? null };
  }

  /** Opens the job's form again in the background and parks it (no-op while it is parked or already rebuilding). */
  rebuild(jobId: string): void {
    if (this.stopped || this.isParked(jobId) || this.rebuilding.has(jobId)) return;
    this.rebuildErrors.delete(jobId);
    const run = (async () => {
      try {
        await this.deps.runRebuild(jobId);
        if (!this.isParked(jobId)) this.rebuildErrors.set(jobId, "The application could not be opened again.");
      } catch (e) {
        this.rebuildErrors.set(jobId, (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim() || "Unexpected error");
      } finally {
        this.rebuilding.delete(jobId);
      }
    })();
    this.rebuilding.set(jobId, run);
  }

  /** The parked page's address and title. */
  async info(jobId: string): Promise<{ url: string; title: string } | null> {
    const p = this.deps.manager.get(jobId);
    if (!p) return null;
    return { url: p.page.url(), title: await withTimeout(p.page.title(), 2_000).catch(() => "") };
  }

  viewerCount(jobId: string): number {
    return this.viewers.get(jobId)?.size ?? 0;
  }

  /** Whether the job's page is streaming its screen right now. */
  isCasting(jobId: string): boolean {
    return this.casts.has(jobId);
  }

  /**
   * Adds a viewer of the job's parked page: it gets the last frame at once, then every new one, the page's address, and
   * a final "status" event when the page goes away. Returns the unsubscribe function, or null when nothing is parked.
   */
  subscribe(jobId: string, send: Viewer): (() => void) | null {
    const p = this.deps.manager.get(jobId);
    if (!p || this.stopped) return null;
    let set = this.viewers.get(jobId);
    if (!set) this.viewers.set(jobId, (set = new Set()));
    set.add(send);
    this.deps.manager.touch(jobId);
    const frame = this.lastFrame.get(jobId);
    if (frame) send(frame);
    void this.info(jobId).then(i => { if (i) send({ type: "meta", ...i }); });
    if (!this.casts.has(jobId)) this.casts.set(jobId, this.startCast(jobId, p.page));
    this.watch(jobId);
    return () => {
      set.delete(send);
      if (set.size) return;
      this.viewers.delete(jobId);
      void this.stopCast(jobId);
    };
  }

  /** Forwards the inputs to the job's parked page, in order. Returns false when nothing is parked. */
  async input(jobId: string, events: LiveInput[]): Promise<boolean> {
    const p = this.deps.manager.get(jobId);
    if (!p) return false;
    this.deps.manager.touch(jobId);
    const w = this.watch(jobId);
    w.lastInput = Date.now();
    const prev = this.inputs.get(jobId) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const e of events) await dispatch(p.page, e).catch(() => {});
    });
    this.inputs.set(jobId, next);
    await next;
    if (this.inputs.get(jobId) === next) this.inputs.delete(jobId);
    return true;
  }

  /**
   * Fills the parked page again with what the app knows: the user's per-job values first, else what the run filled
   * (files first, as runs do). Returns how many fields were filled, or null when nothing is parked.
   */
  async refill(jobId: string): Promise<number | null> {
    const p = this.deps.manager.get(jobId);
    if (!p) return null;
    const overrides = new Map(Object.entries(getOverrides(this.deps.db, jobId)).map(([l, a]) => [normalizeLabel(l, ""), a]));
    const filled = new Map(p.resolutions.flatMap(r => (r.status === "filled" ? [[r.fieldId, r.answer] as const] : [])));
    const root = await p.handler.root(p.page);
    const todo: [FieldSpec, FieldAnswer][] = [];
    for (const f of p.fields) {
      const answer = overrides.get(normalizeLabel(f.label, "")) ?? filled.get(f.id);
      if (!answer || !(await root.locator(`[data-aa-id="${f.id}"]`).count().catch(() => 0))) continue;
      todo.push([f, answer]);
    }
    const isFile = ([f, a]: [FieldSpec, FieldAnswer]) => f.kind === "file" || a.type === "file";
    let n = 0;
    const fill = async ([f, a]: [FieldSpec, FieldAnswer]) => {
      try { await p.handler.fill(p.page, f, a); n++; } catch { /* left as it is */ }
    };
    const files = todo.filter(isFile);
    for (const t of files) await fill(t);
    if (files.length) await p.handler.afterUpload?.(p.page).catch(() => {});
    for (const t of todo.filter(t => !isFile(t))) await fill(t);
    return n;
  }

  /**
   * Attaches the profile's resume to the parked page's resume upload (or its first file upload). Returns whether one
   * was attached; null when nothing is parked.
   */
  async attachResume(jobId: string): Promise<boolean | null> {
    const p = this.deps.manager.get(jobId);
    if (!p) return null;
    const resume = this.resumePath();
    if (!existsSync(resume)) return false;
    const files = p.fields.filter(f => f.kind === "file");
    const field = files.find(f => /resume|cv/i.test(f.label)) ?? files[0];
    try {
      if (field) await p.handler.fill(p.page, field, { type: "file", path: resume });
      else await (await p.handler.root(p.page)).locator("input[type=file]").first().setInputFiles(resume, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Closes the job's parked page. */
  async close(jobId: string): Promise<void> {
    await this.deps.manager.unpark(jobId);
  }

  /**
   * One watch round of a parked page: saves the user's values (see capture), then asks the site whether the application
   * went out. A confirmed submission is recorded and the page closed; anything else (an error message, a CAPTCHA) is
   * left for the user to deal with on the page.
   */
  async tick(jobId: string): Promise<void> {
    const p = this.deps.manager.get(jobId);
    if (!p) return;
    const job = getJob(this.deps.db, jobId);
    if (!job || !canOpenLive(job)) {
      await this.deps.manager.unpark(jobId);
      return;
    }
    await this.capture(jobId, p);
    const outcome = await withTimeout(p.handler.outcome(p.page), 5_000).catch((): SubmitOutcome => ({ kind: "pending" }));
    if (outcome.kind === "submitted") {
      const values = this.captured.get(jobId)?.values ?? new Map();
      await recordLiveSubmission({ db: this.deps.db, onSubmitted: this.deps.onSubmitted }, jobId, p, values);
      this.broadcast(jobId, { type: "status", status: "submitted" });
      await this.deps.manager.unpark(jobId);
    } else if (outcome.kind === "already-applied") {
      resolveNeedsYouForJob(this.deps.db, jobId);
      setStatus(this.deps.db, jobId, "applied-manually", "Already applied");
      try { this.deps.onSubmitted?.(jobId); } catch { /* the tracker must never affect a job */ }
      this.broadcast(jobId, { type: "status", status: "applied-manually" });
      await this.deps.manager.unpark(jobId);
    }
  }

  /** Stops every stream and watch (the pages themselves belong to the SessionManager). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.offChange();
    for (const w of this.watchers.values()) if (w.timer) clearTimeout(w.timer);
    for (const id of [...this.casts.keys()]) await this.stopCast(id);
    this.watchers.clear();
    this.viewers.clear();
  }

  private resumePath() {
    return this.deps.resumePath?.() ?? paths.resume;
  }

  /**
   * Reads every watched field still on the page and saves each value the user gave it (non-empty, and not what the app
   * filled in) as the job's per-job value for that label, so a rebuild fills it again.
   */
  private async capture(jobId: string, p: Parked): Promise<void> {
    let state = this.captured.get(jobId);
    if (!state) this.captured.set(jobId, (state = { values: new Map(), saved: new Map() }));
    const root = await p.handler.root(p.page).catch(() => null);
    if (!root) return;
    for (const w of p.watch) {
      try {
        if (!(await root.locator(`[data-aa-id="${w.field.id}"]`).count())) continue;
        const got = await withTimeout(p.handler.readBack(p.page, w.field), 2_000);
        if (got === null || isEmpty(got) || (w.filled && holds(w.field, w.filled, got))) continue;
        state.values.set(w.field.id, got);
        const answer = toAnswer(w.field, got);
        const json = JSON.stringify(answer);
        if (state.saved.get(w.field.label) === json) continue;
        setOverride(this.deps.db, jobId, w.field.label, answer);
        state.saved.set(w.field.label, json);
      } catch { /* gone or busy: keep the last value read */ }
    }
  }

  /** Keeps the job's page watched: every pollMs while someone views it or gave it input in the last idleMs. */
  private watch(jobId: string) {
    let w = this.watchers.get(jobId);
    if (!w) this.watchers.set(jobId, (w = { timer: null, lastInput: 0, busy: null }));
    const entry = w;
    const schedule = () => {
      if (entry.timer || this.stopped) return;
      entry.timer = setTimeout(async () => {
        entry.timer = null;
        const active = this.viewerCount(jobId) > 0 || Date.now() - entry.lastInput < (this.deps.idleMs ?? IDLE_MS);
        if (!active || !this.isParked(jobId)) return;
        entry.busy = this.tick(jobId).catch(() => {});
        await entry.busy;
        entry.busy = null;
        schedule();
      }, this.deps.pollMs ?? POLL_MS);
      entry.timer.unref?.();
    };
    schedule();
    return entry;
  }

  /** A newly parked page: its file pickers get the resume, and its native drop-downs show inside the page. */
  private prepare(jobId: string) {
    this.rebuildErrors.delete(jobId);
    this.captured.delete(jobId);
    const p = this.deps.manager.get(jobId);
    if (!p) return;
    p.page.on("filechooser", chooser => {
      const resume = this.resumePath();
      if (existsSync(resume)) void chooser.setFiles(resume).catch(() => {});
    });
    p.page.on("framenavigated", (frame: Frame) => {
      if (frame !== p.page.mainFrame()) return;
      void this.info(jobId).then(i => { if (i) this.broadcast(jobId, { type: "meta", ...i }); });
    });
    void p.page.addInitScript(inPage(inPageSelects), undefined).catch(() => {});
    for (const frame of p.page.frames()) void frame.evaluate(inPage(inPageSelects), undefined).catch(() => {});
  }

  /** The job's page went away (submitted, closed, evicted, the job moved on): tell its viewers and forget it. */
  private closed(jobId: string) {
    this.broadcast(jobId, { type: "status", status: getJob(this.deps.db, jobId)?.status === "submitted" ? "submitted" : "closed" });
    const w = this.watchers.get(jobId);
    if (w?.timer) clearTimeout(w.timer);
    this.watchers.delete(jobId);
    this.viewers.delete(jobId);
    this.lastFrame.delete(jobId);
    this.captured.delete(jobId);
    void this.stopCast(jobId);
  }

  private broadcast(jobId: string, e: LiveEvent) {
    for (const v of this.viewers.get(jobId) ?? []) {
      try { v(e); } catch { /* one broken viewer must not stop the others */ }
    }
  }

  private async startCast(jobId: string, page: Page): Promise<CDPSession | null> {
    try {
      const cdp = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        const frame = { type: "frame" as const, data, width: Math.round(metadata.deviceWidth), height: Math.round(metadata.deviceHeight) };
        this.lastFrame.set(jobId, frame);
        this.deps.manager.touch(jobId);
        this.broadcast(jobId, frame);
      });
      const size = await page.evaluate(inPage(() => ({ w: window.innerWidth, h: window.innerHeight }))).catch(() => ({ w: MAX_WIDTH, h: 800 }));
      await cdp.send("Page.startScreencast", {
        format: "jpeg", quality: 70, everyNthFrame: 1, maxWidth: Math.min(MAX_WIDTH, size.w), maxHeight: Math.max(size.h, 1),
      });
      return cdp;
    } catch {
      this.casts.delete(jobId);
      return null;
    }
  }

  private async stopCast(jobId: string) {
    const cast = this.casts.get(jobId);
    if (!cast) return;
    this.casts.delete(jobId);
    const cdp = await cast;
    if (!cdp) return;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

/** The per-job value for what a field holds: an option for choices, the boxes ticked, a check, or the text. */
export function toAnswer(field: FieldSpec, got: string | string[] | boolean): FieldAnswer {
  if (typeof got === "boolean") return { type: "check", checked: got };
  if (Array.isArray(got)) return { type: "options", options: got };
  return CHOICE_KINDS.has(field.kind) ? { type: "option", option: got } : { type: "text", text: got };
}

/** Sends one input to the page, as the CDP Input domain does (through Playwright's mouse and keyboard). */
async function dispatch(page: Page, e: LiveInput): Promise<void> {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  switch (e.t) {
    case "move":
      return page.mouse.move(num(e.x), num(e.y));
    case "down":
    case "up":
    case "click": {
      const button = e.button && BUTTONS.has(e.button) ? e.button : "left";
      const clickCount = Math.min(Math.max(1, Math.round(num(e.clicks) || 1)), 3);
      await page.mouse.move(num(e.x), num(e.y));
      if (e.t === "click") return page.mouse.click(num(e.x), num(e.y), { button, clickCount });
      return e.t === "down" ? page.mouse.down({ button, clickCount }) : page.mouse.up({ button, clickCount });
    }
    case "wheel":
      await page.mouse.move(num(e.x), num(e.y));
      return page.mouse.wheel(num(e.dx), num(e.dy));
    case "keydown":
      if (typeof e.key !== "string" || !e.key) return;
      try {
        await page.keyboard.down(e.key);
      } catch {
        // A character Playwright has no key for (an emoji, an accented letter on some layouts) is typed as text.
        if ([...e.key].length === 1) await page.keyboard.insertText(e.key);
      }
      return;
    case "keyup":
      if (typeof e.key === "string" && e.key) await page.keyboard.up(e.key).catch(() => {});
      return;
    case "text":
      if (typeof e.text === "string" && e.text) await page.keyboard.insertText(e.text);
      return;
  }
}

/**
 * Runs inside the page (each frame): a native drop-down opens its list in a separate window a screencast never shows, so
 * a click on a <select> shows its options as a list inside the page instead; picking one sets it as the site expects
 * (input and change events).
 */
function inPageSelects(): void {
  const w = window as unknown as { __aaSelects?: boolean };
  if (w.__aaSelects) return;
  w.__aaSelects = true;
  let open: HTMLElement | null = null;
  const shut = () => { open?.remove(); open = null; };
  document.addEventListener("mousedown", ev => {
    const target = ev.target as Element | null;
    if (open && target && open.contains(target)) return;
    shut();
    const sel = target?.closest?.("select") as HTMLSelectElement | null;
    if (!sel || sel.multiple || sel.size > 1 || sel.disabled) return;
    ev.preventDefault();
    sel.focus();
    const r = sel.getBoundingClientRect();
    const list = document.createElement("div");
    list.setAttribute("data-aa-select", "");
    list.style.cssText = `position:fixed;z-index:2147483647;left:${r.left}px;top:${r.bottom + 2}px;min-width:${r.width}px;` +
      "max-height:320px;overflow:auto;background:#fff;color:#191919;border:1px solid #888;border-radius:4px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.25);font:14px -apple-system,system-ui,sans-serif;padding:4px 0";
    Array.from(sel.options).forEach((o, i) => {
      const item = document.createElement("div");
      item.textContent = o.textContent || o.value || " ";
      item.style.cssText = "padding:6px 12px;cursor:pointer;white-space:nowrap;" +
        (o.disabled ? "color:#999;" : "") + (i === sel.selectedIndex ? "background:#e8f1fb;" : "");
      item.addEventListener("mouseenter", () => { if (!o.disabled) item.style.background = "#dce9f8"; });
      item.addEventListener("mouseleave", () => { item.style.background = i === sel.selectedIndex ? "#e8f1fb" : ""; });
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        e.stopPropagation();
        if (o.disabled) return;
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        shut();
      });
      list.appendChild(item);
    });
    document.body.appendChild(list);
    open = list;
    const below = window.innerHeight - r.bottom;
    if (below < Math.min(list.offsetHeight, 320) && r.top > below) list.style.top = `${Math.max(0, r.top - list.offsetHeight - 2)}px`;
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") shut(); }, true);
  window.addEventListener("scroll", e => { if (!(open && e.target instanceof Node && open.contains(e.target))) shut(); }, true);
}
