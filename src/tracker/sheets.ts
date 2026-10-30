import { JWT } from "google-auth-library";

export interface SheetsClient {
  /** Replaces the whole contents of one tab (creating it if missing). */
  replaceTab(spreadsheetId: string, tab: string, rows: string[][]): Promise<void>;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const UNREADABLE_KEY = "Stored service-account key is unreadable";
const TIMEOUT_MS = 30_000;
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export function spreadsheetIdFromUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  return /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(u.pathname)?.[1] ?? null;
}

/** Rejects with `message` if `p` hasn't settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** `fetch`, `token` and `timeoutMs` are injectable for tests; production uses a service-account JWT. */
export function googleSheetsClient(
  serviceAccountJson: string,
  deps: { fetch?: typeof fetch; token?: () => Promise<string>; timeoutMs?: number } = {},
): SheetsClient {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const getToken = deps.token ?? (async () => {
    let key: { client_email: string; private_key: string };
    try { key = JSON.parse(serviceAccountJson); } catch { throw new Error(UNREADABLE_KEY); }
    if (!key || typeof key.client_email !== "string" || typeof key.private_key !== "string") throw new Error(UNREADABLE_KEY);
    const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], transporterOptions: { timeout: timeoutMs } });
    const t = (await jwt.getAccessToken()).token;
    if (!t) throw new Error("Could not get a Google access token");
    return t;
  });
  // The token request has its own timeout too, but a hung one must never stall the tracker.
  const token = () => withTimeout(getToken(), timeoutMs, "Timed out getting a Google access token");

  async function call(method: string, url: string, body?: unknown): Promise<any> {
    const res = await doFetch(url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const e = (JSON.parse(text) as { error?: { status?: string; message?: string } }).error;
        if (e) detail = `${e.status ?? ""} ${e.message ?? ""}`.trim();
      } catch { /* keep the raw text */ }
      throw new Error(`Google Sheets ${res.status} ${detail}`);
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    async replaceTab(id, tab, rows) {
      const base = `${API}/${encodeURIComponent(id)}`;
      const meta = await call("GET", `${base}?fields=sheets.properties.title`) as { sheets?: { properties: { title: string } }[] };
      if (!meta.sheets?.some(s => s.properties.title === tab))
        await call("POST", `${base}:batchUpdate`, { requests: [{ addSheet: { properties: { title: tab } } }] });
      await call("POST", `${base}/values/${encodeURIComponent(tab)}:clear`, {});
      const range = `${tab}!A1`;
      await call("PUT", `${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { range, majorDimension: "ROWS", values: rows });
    },
  };
}
