import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Db } from "../db/db.js";
import { canOpenLive, getJob } from "../jobs/repo.js";
import type { Job } from "../jobs/types.js";
import type { LiveEvent, LiveInput } from "../runner/live.js";

/** What the dashboard needs from the live view (LiveService implements it). */
export interface LiveControl {
  isParked(jobId: string): boolean;
  parkedIds(): string[];
  rebuildState(jobId: string): { rebuilding: boolean; error: string | null; startedAt?: number | null };
  rebuild(jobId: string): void;
  info(jobId: string): Promise<{ url: string; title: string } | null>;
  subscribe(jobId: string, send: (e: LiveEvent) => void): (() => void) | null;
  input(jobId: string, events: LiveInput[]): Promise<boolean>;
  refill(jobId: string): Promise<number | null>;
  attachResume(jobId: string): Promise<boolean | null>;
  close(jobId: string): Promise<void>;
  /** Brings the job's parked tab to the front of the Chrome window; false when nothing is parked. */
  front(jobId: string): Promise<boolean>;
}

export type PanelState =
  | { kind: "parked"; url: string; title: string }
  | { kind: "start" }
  | { kind: "rebuilding" }
  | { kind: "error"; error: string }
  | { kind: "closed" }
  | { kind: "opening" };

const MAX_EVENTS = 200;
const PING_MS = 15_000;

/** What the job page's Application panel shows right now. `start` asks for a rebuild when nothing else is going on. */
export async function panelState(live: LiveControl, jobId: string, opts: { start: boolean; requested?: readonly string[] }): Promise<PanelState> {
  const info = live.isParked(jobId) ? await live.info(jobId) : null;
  if (info) return { kind: "parked", ...info };
  const r = live.rebuildState(jobId);
  if (r.rebuilding) return { kind: "rebuilding" };
  if (opts.requested?.includes(jobId)) return { kind: "opening" };
  if (r.error) return { kind: "error", error: r.error };
  return opts.start ? { kind: "start" } : { kind: "closed" };
}

const enc = encodeURIComponent;

/**
 * The job page's Application panel: the parked page's live screen with its toolbar (Refill, Attach resume, Pop out,
 * Close) and a paste box, or what is happening instead (rebuilding, failed, closed).
 */
export function LivePanel(props: { job: Job; state: PanelState }) {
  const { job, state } = props;
  const id = enc(job.id);
  const head = (
    <div class="card-head">
      <h2>Application</h2>
      {state.kind === "parked" ? <span class="chip chip-blue"><span class="live-dot"></span>Live</span> : null}
    </div>
  );
  if (state.kind !== "parked") {
    const waiting = state.kind === "start" || state.kind === "rebuilding";
    const attrs = state.kind === "start"
      ? { "hx-post": `/live/${id}/rebuild`, "hx-trigger": "load", "hx-swap": "outerHTML" }
      : waiting || state.kind === "opening" ? { "hx-get": `/live/${id}/panel`, "hx-trigger": "every 2s", "hx-swap": "outerHTML" } : {};
    return (
      <section class="card live-card" id="live-panel" {...attrs}>
        {head}
        {waiting ? (
          <div class="live-wait"><span class="spinner" aria-hidden="true"></span><div><strong>Rebuilding your application…</strong>
            <div class="meta">Opening the form again in its own tab and filling in everything you've given it. This usually takes under a
              minute; if it isn't done after 90 seconds it is stopped and you can retry.</div></div></div>
        ) : state.kind === "opening" ? (
          <div class="live-wait"><span class="spinner" aria-hidden="true"></span><div><strong>Opening the application in a browser window…</strong></div></div>
        ) : (
          <div class="live-wait">
            <div>
              {state.kind === "error"
                ? <><strong>Couldn't open the application here.</strong><div class="meta">{state.error}</div></>
                : <><strong>The application isn't open.</strong><div class="meta">Open it here to finish it in the app.</div></>}
            </div>
            <button class="primary" hx-post={`/live/${id}/rebuild`} hx-target="#live-panel" hx-swap="outerHTML">
              {state.kind === "error" ? "Retry" : "Open here"}
            </button>
          </div>
        )}
      </section>
    );
  }
  return (
    <section class="card live-card" id="live-panel" data-live={job.id}>
      {head}
      <div class="live-bar">
        <div class="live-addr" title={state.url}>
          <span class="live-title">{state.title || "Application form"}</span>
          <span class="live-url">{state.url}</span>
        </div>
        <div class="live-tools">
          <button class="tertiary" hx-post={`/live/${id}/refill`} hx-target="#live-msg" hx-swap="innerHTML">Refill from my answers</button>
          <button class="tertiary" hx-post={`/live/${id}/attach-resume`} hx-target="#live-msg" hx-swap="innerHTML">Attach resume</button>
          <button class="tertiary" hx-post={`/live/${id}/pop-out`} hx-target="#live-msg" hx-swap="innerHTML"
            title="Show this application's tab in the Chrome window">Pop out</button>
          <button class="tertiary" hx-post={`/live/${id}/close`} hx-target="#live-panel" hx-swap="outerHTML">Close</button>
        </div>
      </div>
      <div class="live-screen" tabindex={0} aria-label="Live application form: click to type into it">
        <img class="live-img" alt="Live view of the application form" draggable="false" />
        <div class="live-empty">Connecting…</div>
      </div>
      <div class="live-foot">
        <span class="meta" id="live-msg" aria-live="polite">Click into the form and type. What you enter is saved as you go; submit with the site's own button.</span>
        <details class="live-paste">
          <summary>Paste text</summary>
          <textarea rows={3} placeholder="Paste or type text here, then Insert to type it where the cursor is"></textarea>
          <button type="button" class="live-insert">Insert</button>
        </details>
      </div>
    </section>
  );
}

/** Renders the panel fragment for the job (used by htmx). */
async function panelHtml(db: Db, live: LiveControl, jobId: string, opts: { start: boolean; requested?: readonly string[] }) {
  const job = getJob(db, jobId)!;
  return <LivePanel job={job} state={await panelState(live, jobId, opts)} />;
}

const isInput = (e: unknown): e is LiveInput => {
  if (!e || typeof e !== "object") return false;
  const t = (e as { t?: unknown }).t;
  return typeof t === "string" && ["move", "down", "up", "click", "wheel", "keydown", "keyup", "text"].includes(t);
};

/**
 * The live view's endpoints, all for jobs the live view may show (canOpenLive; 409 otherwise): the panel fragment, a
 * rebuild, the screen stream (Server-Sent Events), input, refill, attach resume, pop out and close.
 */
export function liveRoutes(app: Hono, ctx: { db: Db; live: LiveControl; requestedRuns?(): readonly string[] }) {
  const { db, live } = ctx;
  const check = (jobId: string): [string, 404 | 409] | null => {
    const job = getJob(db, jobId);
    if (!job) return ["Unknown job", 404];
    if (!canOpenLive(job)) return ["Only an application waiting for your input or review can be opened here", 409];
    return null;
  };
  const requested = () => ctx.requestedRuns?.() ?? [];

  app.get("/live/:id/panel", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) {
      // A job that moved on (submitted, requeued...) while its page was shown: show the job page as it is now.
      if (bad[1] === 409) { c.header("HX-Refresh", "true"); return c.body(null, 204); }
      return c.text(...bad);
    }
    return c.html(await panelHtml(db, live, id, { start: false, requested: requested() }));
  });

  /** The panel's state as JSON: parked, rebuilding (with how long so far), opening, error (with why), start or closed. */
  app.get("/live/:id/status", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.json({ kind: "unavailable", error: bad[0] }, bad[1]);
    const state = await panelState(live, id, { start: false, requested: requested() });
    const startedAt = state.kind === "rebuilding" ? live.rebuildState(id).startedAt ?? null : null;
    return c.json({ ...state, ...(startedAt ? { elapsedMs: Date.now() - startedAt } : {}) });
  });

  app.post("/live/:id/rebuild", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.text(...bad);
    if (!requested().includes(id)) live.rebuild(id);
    return c.html(await panelHtml(db, live, id, { start: false, requested: requested() }));
  });

  app.get("/live/:id/stream", c => {
    const id = c.req.param("id");
    // Only the dashboard's own page may watch (another site could not read it anyway, but must not start a stream).
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return c.text("Forbidden: cross-site request", 403);
    const bad = check(id);
    if (bad) return c.text(...bad);
    if (!live.isParked(id)) return c.text("The application isn't open", 409);
    return streamSSE(c, async stream => {
      let finish!: () => void;
      const done = new Promise<void>(r => { finish = r; });
      stream.onAbort(() => finish());
      // Only the newest frame waits to be sent: a slow connection skips frames instead of falling behind.
      let frame: string | null = null;
      const others: { event: string; data: string }[] = [];
      let writing = false;
      const pump = async () => {
        if (writing) return;
        writing = true;
        try {
          while (others.length || frame) {
            const next = others.shift() ?? { event: "frame", data: frame! };
            if (next.event === "frame") frame = null;
            await stream.writeSSE(next);
            if (next.event === "status") finish();
          }
        } catch {
          finish();
        } finally {
          writing = false;
        }
      };
      const unsubscribe = live.subscribe(id, e => {
        if (e.type === "frame") frame = JSON.stringify({ d: e.data, w: e.width, h: e.height });
        else others.push({ event: e.type, data: JSON.stringify(e.type === "meta" ? { url: e.url, title: e.title } : { status: e.status }) });
        void pump();
      });
      if (!unsubscribe) {
        await stream.writeSSE({ event: "status", data: JSON.stringify({ status: "closed" }) });
        return;
      }
      const ping = setInterval(() => { others.push({ event: "ping", data: "" }); void pump(); }, PING_MS);
      try {
        await done;
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });

  app.post("/live/:id/input", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.text(...bad);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.text("Send JSON", 400); }
    const events = (body as { events?: unknown })?.events;
    if (!Array.isArray(events) || events.length > MAX_EVENTS || !events.every(isInput)) return c.text("Unknown input", 400);
    return (await live.input(id, events)) ? c.body(null, 204) : c.text("The application isn't open", 409);
  });

  app.post("/live/:id/refill", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.text(...bad);
    const n = await live.refill(id);
    if (n === null) return c.text("The application isn't open", 409);
    return c.html(<>Filled {n} {n === 1 ? "field" : "fields"} from your answers.</>);
  });

  app.post("/live/:id/attach-resume", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.text(...bad);
    const ok = await live.attachResume(id);
    if (ok === null) return c.text("The application isn't open", 409);
    return c.html(ok ? <>Attached your resume.</> : <>Couldn't attach your resume: upload one in <a href="/profile">Profile</a>, or the form has no file upload.</>);
  });

  app.post("/live/:id/pop-out", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.text(...bad);
    // The application is a tab of the app's Chrome window: bring it forward there (no second browser).
    if (!(await live.front(id).catch(() => false))) return c.text("The application isn't open", 409);
    return c.html(<>Brought to the front of the Chrome window.</>);
  });

  app.post("/live/:id/close", async c => {
    const id = c.req.param("id");
    const bad = check(id);
    if (bad) return c.text(...bad);
    await live.close(id);
    return c.html(await panelHtml(db, live, id, { start: false, requested: requested() }));
  });
}

/** Styles of the Application panel (static). */
export const LIVE_CSS = `
.live-card { padding: 0; overflow: hidden; }
.live-card .card-head { padding: 16px 16px 8px; margin: 0; }
.live-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 8px 16px;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); }
.live-addr { min-width: 0; flex: 1 1 260px; display: flex; flex-direction: column; }
.live-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live-url { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.live-screen { position: relative; background: #fff; outline: none; cursor: default; line-height: 0; min-height: 120px; }
.live-screen:focus-visible { box-shadow: inset 0 0 0 3px var(--focus); }
.live-img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
.live-screen:not(.has-frame) .live-img { display: none; }
.live-empty { line-height: 1.45; padding: 48px 16px; text-align: center; color: #666; }
.live-screen.has-frame .live-empty { display: none; }
.live-foot { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; padding: 10px 16px 14px;
  border-top: 1px solid var(--border); }
.live-paste summary { cursor: pointer; color: var(--primary); font-weight: 600; }
.live-paste textarea { display: block; width: min(420px, 80vw); margin: 8px 0; }
.live-wait { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 16px 18px; }
.live-wait > div { flex: 1; }
.spinner { width: 20px; height: 20px; border-radius: 50%; border: 2.5px solid var(--border); border-top-color: var(--primary);
  animation: spin .9s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

/**
 * The panel's browser side (static): shows the stream's frames, scales mouse positions to the page's own pixels, and
 * sends mouse, wheel, keyboard and pasted text in order (one request at a time, batching what piles up meanwhile).
 */
export const LIVE_SCRIPT = `
(function () {
  var BUTTONS = ["left", "middle", "right"];
  function init(el) {
    if (el.getAttribute("data-live-ready")) return;
    el.setAttribute("data-live-ready", "1");
    var id = encodeURIComponent(el.getAttribute("data-live"));
    var screen = el.querySelector(".live-screen");
    var img = el.querySelector(".live-img");
    var title = el.querySelector(".live-title");
    var url = el.querySelector(".live-url");
    var empty = el.querySelector(".live-empty");
    var w = 1280, h = 720, gone = false;
    var es = new EventSource("/live/" + id + "/stream");
    es.addEventListener("frame", function (e) {
      var f = JSON.parse(e.data);
      w = f.w || w; h = f.h || h;
      img.src = "data:image/jpeg;base64," + f.d;
      screen.classList.add("has-frame");
    });
    es.addEventListener("meta", function (e) {
      var m = JSON.parse(e.data);
      title.textContent = m.title || "Application form";
      url.textContent = m.url;
      el.querySelector(".live-addr").title = m.url;
    });
    es.addEventListener("status", function (e) {
      gone = true;
      es.close();
      var s = JSON.parse(e.data).status;
      if (s === "closed") { if (document.body.contains(el)) htmx.ajax("GET", "/live/" + id + "/panel", { target: "#live-panel", swap: "outerHTML" }); }
      else location.reload();
    });
    es.onerror = function () { if (!gone) empty.textContent = "Reconnecting…"; };
    var queue = [], sending = false;
    function flush() {
      if (sending || !queue.length || gone) return;
      sending = true;
      var batch = queue.splice(0, queue.length);
      fetch("/live/" + id + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }) })
        .catch(function () {}).then(function () { sending = false; flush(); });
    }
    function send(e) { queue.push(e); flush(); }
    function pos(e) {
      var r = img.getBoundingClientRect();
      return { x: Math.round((e.clientX - r.left) * w / r.width), y: Math.round((e.clientY - r.top) * h / r.height) };
    }
    var lastMove = 0;
    img.addEventListener("mousemove", function (e) {
      var now = Date.now();
      if (now - lastMove < 40) return;
      lastMove = now;
      var p = pos(e);
      send({ t: "move", x: p.x, y: p.y });
    });
    img.addEventListener("mousedown", function (e) {
      e.preventDefault();
      screen.focus();
      var p = pos(e);
      send({ t: "down", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", clicks: e.detail || 1 });
    });
    img.addEventListener("mouseup", function (e) {
      var p = pos(e);
      send({ t: "up", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", clicks: e.detail || 1 });
    });
    img.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    img.addEventListener("wheel", function (e) {
      e.preventDefault();
      var k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1;
      var p = pos(e);
      send({ t: "wheel", x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k });
    }, { passive: false });
    function pasteKey(e) { return (e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V"); }
    screen.addEventListener("keydown", function (e) {
      if (pasteKey(e)) return;
      e.preventDefault();
      send({ t: "keydown", key: e.key });
    });
    screen.addEventListener("keyup", function (e) {
      if (pasteKey(e)) return;
      e.preventDefault();
      send({ t: "keyup", key: e.key });
    });
    screen.addEventListener("paste", function (e) {
      var text = e.clipboardData && e.clipboardData.getData("text");
      if (!text) return;
      e.preventDefault();
      send({ t: "text", text: text });
    });
    var box = el.querySelector(".live-paste textarea");
    el.querySelector(".live-insert").addEventListener("click", function () {
      if (box.value) send({ t: "text", text: box.value });
      box.value = "";
      screen.focus();
    });
    window.addEventListener("pagehide", function () { es.close(); });
  }
  function scan() { document.querySelectorAll("[data-live]").forEach(init); }
  document.addEventListener("DOMContentLoaded", scan);
  document.addEventListener("htmx:afterSettle", scan);
  scan();
})();
`;

