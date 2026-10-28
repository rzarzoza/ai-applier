import type { Child } from "hono/jsx";
import type { Job, JobStatus } from "../jobs/types.js";

/** Muted backgrounds for company avatars (white initials read on each, in both themes). */
const AVATAR_COLORS = ["#5b7083", "#6f6391", "#4c7a6b", "#8a6a4f", "#5f7a3d", "#8a5468", "#4a6d91", "#7d7348", "#6a5f7d", "#477b85"];

/** Up to two initials of the company's name ("Jane Street" → "JS", "Stripe" → "S"). */
export function initials(company: string): string {
  const words = company.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.slice(0, 2).map(w => [...w][0]!.toUpperCase());
  return letters.join("") || "?";
}

/** The same company always gets the same color. */
export function avatarColor(company: string): string {
  let h = 0;
  for (const ch of company.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function Avatar(props: { company: string; size?: "md" | "lg" }) {
  return (
    <span class={`avatar${props.size === "lg" ? " avatar-lg" : ""}`} style={`background:${avatarColor(props.company)}`} aria-hidden="true">
      {initials(props.company)}
    </span>
  );
}

const CHIPS: Record<JobStatus, [label: string, cls: string]> = {
  new: ["New", "chip-gray"],
  queued: ["Queued", "chip-gray"],
  filling: ["Applying now", "chip-blue"],
  "needs-you": ["Needs input", "chip-amber"],
  "ready-to-review": ["Ready to review", "chip-blue-outline"],
  submitted: ["Submitted", "chip-green"],
  "applied-manually": ["Applied manually", "chip-green"],
  failed: ["Failed", "chip-red"],
  unsupported: ["Unsupported", "chip-gray-outline"],
  closed: ["Closed", "chip-muted"],
  skipped: ["Skipped", "chip-muted"],
  "duplicate-role": ["Duplicate", "chip-muted"],
};

export const statusLabel = (s: JobStatus) => CHIPS[s][0];

export function StatusChip(props: { status: JobStatus }) {
  const [label, cls] = CHIPS[props.status];
  return <span class={`chip ${cls}`}>{label}</span>;
}

export function Chip(props: { cls: string; children?: Child }) {
  return <span class={`chip ${props.cls}`}>{props.children}</span>;
}

export const jobLocation = (j: Job) => j.chosenLocation ?? j.locations.join(" · ");

export const shortDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/** "today", "3 days ago", "2 weeks ago" — how long ago, at a glance. */
export function ago(d: Date, now = new Date()): string {
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** "45s", "3m 05s", "1h 02m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function PageHead(props: { title: string; subtitle?: Child; actions?: Child }) {
  return (
    <div class="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.subtitle ? <p class="subtitle">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div class="page-actions">{props.actions}</div> : null}
    </div>
  );
}

const ICON_PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  applications: "M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6M3 7h18v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 12h18",
  bank: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  sources: "M3 5h18l-7 8v6l-4 2v-8z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.5-1.9-.7a7 7 0 0 1-1.7 1l-.3 2h-4l-.3-2a7 7 0 0 1-1.7-1l-1.9.7-2-3.5 1.6-1.2a7 7 0 0 1 0-3L2.9 9.3l2-3.5 1.9.7a7 7 0 0 1 1.7-1l.3-2h4l.3 2a7 7 0 0 1 1.7 1l1.9-.7 2 3.5-1.6 1.2a7 7 0 0 1 0 3z",
  alert: "M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M5 12.5l4.5 4.5L19 7.5",
};

export function Icon(props: { name: keyof typeof ICON_PATHS | string; size?: number }) {
  const size = props.size ?? 24;
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[props.name] ?? ""} />
    </svg>
  );
}
