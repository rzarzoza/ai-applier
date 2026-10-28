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
  headless: boolean;
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  reviewMode: "off",
  reviewCompanies: [],
  dailyLimit: null,
  pollMinutes: 30,
  headless: false,
  paused: false,
};

const SETTINGS_KEY = "settings";

export function getSettings(db: Db): Settings {
  return { ...DEFAULT_SETTINGS, ...getJson<Partial<Settings>>(db, SETTINGS_KEY, {}) };
}

export function saveSettings(db: Db, patch: Partial<Settings>): Settings {
  const next = { ...getSettings(db), ...patch };
  setJson(db, SETTINGS_KEY, next);
  return next;
}
