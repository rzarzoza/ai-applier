// Append-only: later tasks add new entries; never edit an earlier one.
export const migrations: string[] = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    etag TEXT,
    last_polled_at TEXT
  );
  INSERT INTO sources (id, kind, url, enabled) VALUES (
    'simplify-summer2027',
    'simplify-json',
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
    1
  );`,
];
