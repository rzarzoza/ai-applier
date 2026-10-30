import type { SourceConfig } from "./types.js";

export type ConditionalResult = { notModified: true } | { notModified: false; etag: string | null; body: string };

/** GET with If-None-Match when cfg.etag is set. Throws on anything but 2xx/304. */
export async function conditionalGet(cfg: SourceConfig, fetchFn: typeof fetch): Promise<ConditionalResult> {
  const headers: Record<string, string> = {};
  if (cfg.etag) headers["If-None-Match"] = cfg.etag;
  const res = await fetchFn(cfg.url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`Source ${cfg.id}: HTTP ${res.status} from ${cfg.url}`);
  return { notModified: false, etag: res.headers.get("etag"), body: await res.text() };
}
