const DROPPED_PARAMS = /^(utm_[^=]*|ref|source)$/i;

/** Lowercases the host, drops tracking params (utm_*, ref, source) and the trailing slash. */
export function normalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  const kept = u.search
    .replace(/^\?/, "")
    .split("&")
    .filter(pair => pair !== "" && !DROPPED_PARAMS.test(pair.split("=")[0]));
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path}${kept.length ? "?" + kept.join("&") : ""}${u.hash}`;
}
