/**
 * The corner panel: what was filled, what is left for the user (click one to go to it), drafts to use, Refill, Pause on
 * this site. It lives in a shadow root so the site's CSS can't reach it (nor its CSS the site), styled like the app.
 */

export interface LeftItem {
  fieldId: string;
  /** The field's label exactly as the form shows it. */
  label: string; required: boolean;
  /** Why it's left: a question only the user can answer, a file, an option the app couldn't pick, a draft... */
  note: string;
  /** Whether filling it was tried and failed (shown as an error, not a to-do). */
  failed?: boolean;
  suggestion?: string;
  /** Options to pick with one click (the closest ones to the answer that matched none). */
  choices?: string[];
}
export interface DoneItem { fieldId: string; label: string; value: string }
/** A section the user adds entries to themselves (see sections.ts). */
export interface ManualItem { id: string; label: string }
export interface PanelView {
  phase: "working" | "done" | "error" | "submitted";
  message?: string;
  filled: number; total: number; left: LeftItem[];
  done?: DoneItem[];
  manual?: ManualItem[];
}
export interface PanelActions {
  focus(fieldId: string): void;
  useSuggestion(fieldId: string): void;
  /** The user picked one of a field's quick-pick options. */
  pick(fieldId: string, option: string): void;
  focusManual(id: string): void;
  refill(): void;
  pauseSite(): void;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  --bg: #ffffff; --text: #191919; --muted: #666666; --border: #e0dfdc; --primary: #0a66c2; --primary-hover: #004182;
  --success: #057642; --success-tint: #e5f2eb; --warning: #915907; --warning-tint: #fdf2dd; --danger: #cc1016; --hover: rgba(0,0,0,.05);
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 340px; max-height: min(70vh, 560px);
  display: flex; flex-direction: column; background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,.18); font: 14px/1.4 -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel { --bg: #1b1f23; --text: #e9e5df; --muted: #a8b0b8; --border: #38434f; --primary: #70b5f9; --primary-hover: #a8d4ff;
    --success: #6ccf96; --success-tint: #16301f; --warning: #f0b45c; --warning-tint: #3a2c12; --danger: #f6837a; --hover: rgba(255,255,255,.07); }
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.logo { width: 22px; height: 22px; border-radius: 5px; background: var(--primary); color: #fff; font-weight: 700; font-size: 12px;
  display: grid; place-items: center; flex: none; }
.title { font-weight: 600; flex: 1; }
.icon { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.icon:hover { background: var(--hover); color: var(--text); }
.status { padding: 10px 12px 6px; }
.status strong { font-weight: 600; }
.msg { color: var(--muted); font-size: 13px; padding: 0 12px 8px; }
.msg.err { color: var(--danger); }
.list { overflow: auto; padding: 0 6px 6px; margin: 0; list-style: none; flex: 1 1 auto; min-height: 96px; }
.item { padding: 6px; border-radius: 6px; }
.item:hover { background: var(--hover); }
.go { all: unset; cursor: pointer; display: block; width: 100%; }
.label { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.req { color: var(--danger); margin-left: 2px; }
.note { font-size: 12px; color: var(--warning); overflow-wrap: anywhere; }
.note.fail { color: var(--danger); }
.choices { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
button.chip { font: inherit; font-size: 12px; border: 1px solid var(--border); background: transparent; color: var(--text); border-radius: 12px;
  padding: 2px 8px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.chip:hover { border-color: var(--primary); color: var(--primary); }
.section { font-size: 12px; font-weight: 600; color: var(--muted); padding: 6px 12px 2px; text-transform: uppercase; letter-spacing: .03em; }
details.filled { padding: 0 12px 6px; flex: 0 1 auto; max-height: 35%; overflow: auto; }
details.filled summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 4px 0; }
.done { font-size: 12px; padding: 2px 0; overflow-wrap: anywhere; }
.done .tick { color: var(--success); margin-right: 4px; }
.done .val { color: var(--muted); }
.sugg { font-size: 12px; color: var(--muted); margin-top: 4px; white-space: pre-wrap; max-height: 4.2em; overflow: hidden; }
.foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
button.btn { font: inherit; font-weight: 600; font-size: 13px; border-radius: 16px; padding: 4px 12px; cursor: pointer;
  border: 1px solid var(--primary); color: var(--primary); background: transparent; }
button.btn:hover { background: var(--hover); }
button.btn.primary { background: var(--primary); color: #fff; }
button.btn.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
button.small { font-size: 12px; padding: 2px 10px; margin-top: 4px; }
.pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px; cursor: pointer;
  border: 1px solid #e0dfdc; background: #fff; color: #191919; border-radius: 20px; padding: 6px 12px 6px 6px;
  box-shadow: 0 2px 12px rgba(0,0,0,.18); font: 600 13px/1.2 -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.ok { color: var(--success); }
`;

export const PANEL_HOST_ID = "ai-applier-panel-host";

export class Panel {
  private host: HTMLElement;
  private root: ShadowRoot;
  private minimized = false;
  private filledOpen = false;
  private view: PanelView = { phase: "working", filled: 0, total: 0, left: [] };

  constructor(private actions: PanelActions) {
    this.host = document.createElement("div");
    this.host.id = PANEL_HOST_ID;
    this.root = this.host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(this.host);
  }

  update(view: PanelView): void {
    this.view = view;
    // The page may have re-rendered and dropped the panel.
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    this.render();
  }

  remove(): void { this.host.remove(); }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  private summary(): string {
    const v = this.view;
    if (v.phase === "working") return v.message ?? "Filling…";
    if (v.phase === "submitted") return "Application sent — saved to the app";
    if (v.phase === "error") return "Couldn't fill this form";
    const todo = v.left.length + (v.manual?.length ?? 0);
    return `Filled ${v.filled} of ${v.total}${todo ? ` · ${todo} need${todo === 1 ? "s" : ""} you` : " · all set"}`;
  }

  private render(): void {
    const root = this.root;
    root.replaceChildren();
    const style = this.el("style");
    style.textContent = CSS;
    root.appendChild(style);
    const v = this.view;

    if (this.minimized) {
      const pill = this.el("div", "pill");
      pill.setAttribute("role", "button");
      pill.append(this.el("span", "logo", "AI"), this.el("span", undefined, this.summary()));
      pill.addEventListener("click", () => { this.minimized = false; this.render(); });
      root.appendChild(pill);
      return;
    }

    const panel = this.el("section", "panel");
    panel.setAttribute("aria-label", "AI Applier");
    const head = this.el("div", "head");
    const min = this.el("button", "icon", "–");
    min.title = "Minimize";
    min.addEventListener("click", () => { this.minimized = true; this.render(); });
    head.append(this.el("span", "logo", "AI"), this.el("span", "title", "AI Applier"), min);
    panel.appendChild(head);

    const status = this.el("div", "status");
    const allSet = v.phase === "done" && !v.left.length && !v.manual?.length;
    const strong = this.el("strong", v.phase === "submitted" || allSet ? "ok" : undefined, this.summary());
    status.appendChild(strong);
    panel.appendChild(status);
    if (v.message && v.phase !== "working") panel.appendChild(this.el("div", v.phase === "error" ? "msg err" : "msg", v.message));
    if (allSet) panel.appendChild(this.el("div", "msg", "Review the form, then submit it yourself."));

    const list = this.el("ul", "list");
    for (const item of v.left) {
      const li = this.el("li", "item");
      li.dataset.field = item.fieldId;
      const go = this.el("button", "go");
      const label = this.el("span", "label", item.label || "(unlabeled field)");
      if (item.required) label.appendChild(this.el("span", "req", "*"));
      go.append(label, this.el("div", item.failed ? "note fail" : "note", item.note));
      go.addEventListener("click", () => this.actions.focus(item.fieldId));
      li.appendChild(go);
      if (item.choices?.length) {
        const row = this.el("div", "choices");
        row.setAttribute("aria-label", "Pick one");
        for (const c of item.choices) {
          const chip = this.el("button", "chip", c);
          chip.title = `Pick "${c}" (remembered for this question)`;
          chip.addEventListener("click", () => this.actions.pick(item.fieldId, c));
          row.appendChild(chip);
        }
        li.appendChild(row);
      }
      if (item.suggestion !== undefined) {
        li.appendChild(this.el("div", "sugg", item.suggestion));
        const use = this.el("button", "btn small", "Use suggestion");
        use.addEventListener("click", () => this.actions.useSuggestion(item.fieldId));
        li.appendChild(use);
      }
      list.appendChild(li);
    }
    for (const m of v.manual ?? []) {
      const li = this.el("li", "item manual");
      const go = this.el("button", "go");
      const what = /educat/i.test(m.label) ? "education" : "experience";
      go.append(this.el("span", "label", m.label), this.el("div", "note", `Add your ${what} manually — the extension doesn't add entries`));
      go.addEventListener("click", () => this.actions.focusManual(m.id));
      li.appendChild(go);
      list.appendChild(li);
    }
    if (list.children.length) panel.appendChild(list);

    if (v.done?.length) {
      const details = this.el("details", "filled");
      details.open = this.filledOpen;
      details.addEventListener("toggle", () => { this.filledOpen = details.open; });
      details.appendChild(this.el("summary", undefined, `Filled (${v.done.length})`));
      for (const d of v.done) {
        const row = this.el("div", "done");
        row.append(this.el("span", "tick", "✓"), this.el("span", undefined, `${d.label || "(unlabeled field)"}: `), this.el("span", "val", d.value));
        details.appendChild(row);
      }
      panel.appendChild(details);
    }

    if (v.phase !== "submitted") {
      const foot = this.el("div", "foot");
      const refill = this.el("button", "btn primary", "Refill");
      refill.disabled = v.phase === "working";
      refill.addEventListener("click", () => this.actions.refill());
      const pause = this.el("button", "btn", "Pause on this site");
      pause.addEventListener("click", () => this.actions.pauseSite());
      foot.append(refill, pause);
      panel.appendChild(foot);
    }
    root.appendChild(panel);
  }
}
