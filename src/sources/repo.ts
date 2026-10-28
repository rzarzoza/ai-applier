import type { Db } from "../db/db.js";
import type { SourceConfig } from "./types.js";

interface Row { id: string; kind: SourceConfig["kind"]; url: string; enabled: number; etag: string | null; last_polled_at: string | null }

export function listSources(db: Db): SourceConfig[] {
  const rows = db.prepare("SELECT id, kind, url, enabled, etag, last_polled_at FROM sources ORDER BY rowid").all() as unknown as Row[];
  return rows.map(r => ({ id: r.id, kind: r.kind, url: r.url, enabled: r.enabled === 1, etag: r.etag, lastPolledAt: r.last_polled_at }));
}

export function addSource(db: Db, cfg: Omit<SourceConfig, "etag" | "lastPolledAt">): void {
  db.prepare("INSERT INTO sources (id, kind, url, enabled) VALUES (?, ?, ?, ?)").run(cfg.id, cfg.kind, cfg.url, cfg.enabled ? 1 : 0);
}

export function setSourceEnabled(db: Db, id: string, enabled: boolean): void {
  db.prepare("UPDATE sources SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function markPolled(db: Db, id: string, etag: string | null, at: Date): void {
  db.prepare("UPDATE sources SET etag = ?, last_polled_at = ? WHERE id = ?").run(etag, at.toISOString(), id);
}
