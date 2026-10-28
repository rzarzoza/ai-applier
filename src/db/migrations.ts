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
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    locations TEXT NOT NULL,
    chosen_location TEXT,
    category TEXT,
    terms TEXT NOT NULL,
    url TEXT NOT NULL,
    url_norm TEXT NOT NULL UNIQUE,
    date_posted TEXT NOT NULL,
    active INTEGER NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    ats TEXT,
    role_key TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (source_id, listing_id)
  );
  CREATE INDEX idx_jobs_status ON jobs (status);
  CREATE INDEX idx_jobs_role_key ON jobs (role_key);`,
];
