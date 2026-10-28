import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.js";
import { paths } from "../paths.js";
import { TRACKER_HEADERS, trackerRows } from "./rows.js";

const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Rewrites the whole tracker file (RFC 4180) through a temp file and a rename, so readers never see half a file. */
export function writeTrackerCsv(db: Db, file: string = path.join(paths.dataDir, "applications.csv")): void {
  const text = [TRACKER_HEADERS, ...trackerRows(db)].map(r => r.map(field).join(",")).join("\r\n") + "\r\n";
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
