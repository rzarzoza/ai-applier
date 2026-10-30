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
}

export const DEFAULT_SETTINGS: Settings = {
  reviewMode: "off",
  reviewCompanies: [],
  dailyLimit: null,
  pollMinutes: 30,
  paused: false,
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
