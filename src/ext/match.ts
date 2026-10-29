import type { Db } from "../db/db.js";
import { getJob } from "../jobs/repo.js";
import type { Job } from "../jobs/types.js";
import { normalizeUrl } from "../sources/normalize.js";

/**
 * The posting a URL points at, as an ATS-specific key: the same Greenhouse job is reached as
 * job-boards.greenhouse.io/acme/jobs/123, boards.greenhouse.io/acme/jobs/123?gh_src=x, or a company page with
 * ?gh_jid=123; a Lever or Ashby posting adds /apply or /application for its form. Null when the URL names none.
 */
export function postingKey(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const ghJid = u.searchParams.get("gh_jid") ?? u.searchParams.get("token");
  if (host.endsWith("greenhouse.io")) {
    const i = parts.indexOf("jobs");
    const id = i >= 0 ? parts[i + 1] : ghJid;
    if (id && /^\d+$/.test(id)) return `gh:${id}`;
  }
  if (ghJid && /^\d+$/.test(ghJid) && u.searchParams.has("gh_jid")) return `gh:${ghJid}`;
  if (host === "jobs.lever.co" && parts[1]) return `lever:${parts[1].toLowerCase()}`;
  if (host === "jobs.ashbyhq.com" && parts[1]) return `ashby:${parts[1].toLowerCase()}`;
  if (host === "apply.workable.com") {
    const j = parts.indexOf("j");
    if (j >= 0 && parts[j + 1]) return `workable:${parts[j + 1].toLowerCase()}`;
  }
  if (host === "jobs.smartrecruiters.com" && parts[1]) return `sr:${parts[1].split("-")[0]}`;
  if (host.endsWith("myworkdayjobs.com")) {
    // .../job/<location>/<Title>_<REQ123>[/apply[/...]]
    const j = parts.indexOf("job");
    const slug = j >= 0 ? parts.slice(j + 1).find(p => /_[A-Za-z0-9-]+$/.test(p)) : undefined;
    if (slug) return `wd:${host}:${slug.toLowerCase()}`;
  }
  return null;
}

/** The URL without its query, hash, trailing slash and a trailing /apply or /application step. */
function basePath(url: string): string | null {
  try {
    const u = new URL(normalizeUrl(url));
    return `${u.origin}${u.pathname.replace(/\/(apply|application)(\/.*)?$/i, "").replace(/\/+$/, "")}`.toLowerCase();
  } catch { return null; }
}

/**
 * The job row for a page the extension is on: the same normalized URL, else the same posting (postingKey), else the
 * same page ignoring its query and form step. The most recently updated row wins.
 */
export function findJobByUrl(db: Db, url: string): Job | null {
  const exact = db.prepare("SELECT id FROM jobs WHERE url_norm = ? ORDER BY updated_at DESC LIMIT 1").get(normalizeUrl(url)) as { id: string } | undefined;
  if (exact) return getJob(db, exact.id);

  const key = postingKey(url);
  if (key) {
    const needle = key.split(":").pop()!;
    const rows = db.prepare("SELECT id, url FROM jobs WHERE instr(lower(url), ?) > 0 ORDER BY updated_at DESC LIMIT 50")
      .all(needle.toLowerCase()) as { id: string; url: string }[];
    const hit = rows.find(r => postingKey(r.url) === key);
    if (hit) return getJob(db, hit.id);
  }

  const base = basePath(url);
  if (base) {
    const rows = db.prepare("SELECT id, url FROM jobs WHERE instr(lower(url_norm), ?) = 1 ORDER BY updated_at DESC LIMIT 50")
      .all(base) as { id: string; url: string }[];
    const hit = rows.find(r => basePath(r.url) === base);
    if (hit) return getJob(db, hit.id);
  }
  return null;
}
