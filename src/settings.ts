import type { Db } from "./db/db.js";

export function getJson<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setJson(db: Db, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export interface Settings {
  reviewMode: "off" | "all" | "companies";
  reviewCompanies: string[];
  dailyLimit: number | null;
  pollMinutes: number;
  paused: boolean;
  /**
   * Whether the scheduler takes queued jobs on its own (off by default: the app only applies when the user asks, or
   * through the browser extension). `paused` still pauses it when on.
   */
  backgroundApplier: boolean;
  /** Where each kind of AI task runs (see llm/routed.ts): "fast" (classify, match, adapt...) and "write" (drafts...). */
  aiFast: AiProvider;
  aiWrite: AiProvider;
  /** The local model (Ollama). */
  ollamaUrl: string;
  ollamaModel: string;
  /** When the local model can't be reached: use Claude (within the daily budget) or leave the field for the user. */
  aiLocalOff: "claude" | "leave";
  /** Claude spend allowed per day, in US dollars; once reached, Claude calls stop until tomorrow. */
  aiDailyBudgetUsd: number;
}

export type AiProvider = "local" | "claude";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:14b";

export const DEFAULT_SETTINGS: Settings = {
  reviewMode: "off",
  reviewCompanies: [],
  dailyLimit: null,
  pollMinutes: 30,
  paused: false,
  backgroundApplier: false,
  // Everything runs on the local model by default: Claude is only called once the user picks it in Settings.
  aiFast: "local",
  aiWrite: "local",
  ollamaUrl: DEFAULT_OLLAMA_URL,
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  aiLocalOff: "leave",
  aiDailyBudgetUsd: 1,
};

const SETTINGS_KEY = "settings";

export function getSettings(db: Db): Settings {
  // The browser is always a visible Chrome window now: an older "headless" setting is ignored (and dropped on save).
  const { headless: _headless, ...stored } = getJson<Partial<Settings> & { headless?: unknown }>(db, SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

const HALT_KEY = "runnerHalt";

export interface RunnerHalt { at: string; reason: string }

/** Pauses the runner because of a problem no job can get past (shown as "Paused: <reason>"). */
export function haltRunner(db: Db, reason: string, now: Date = new Date()): void {
  saveSettings(db, { paused: true });
  setJson(db, HALT_KEY, { at: now.toISOString(), reason } satisfies RunnerHalt);
}

export function getRunnerHalt(db: Db): RunnerHalt | null {
  return getJson<RunnerHalt | null>(db, HALT_KEY, null);
}

export function clearRunnerHalt(db: Db): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(HALT_KEY);
}

export function saveSettings(db: Db, patch: Partial<Settings>): Settings {
  const next = { ...getSettings(db), ...patch };
  setJson(db, SETTINGS_KEY, next);
  return next;
}
