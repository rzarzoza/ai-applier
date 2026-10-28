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
  `CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical TEXT NOT NULL,
    kind TEXT NOT NULL,
    is_factual INTEGER NOT NULL,
    answer TEXT,
    draft TEXT,
    status TEXT NOT NULL,
    options TEXT,
    use_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE question_variants (
    question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (question_id, label)
  );
  CREATE TABLE job_blockers (
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    PRIMARY KEY (job_id, question_id)
  );
  CREATE TABLE needs_you (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE job_overrides (
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    field_label TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    PRIMARY KEY (job_id, field_label)
  );
  CREATE TABLE field_cache (
    key TEXT PRIMARY KEY,
    classification_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE job_snapshots (
    job_id TEXT PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
    fields_json TEXT NOT NULL,
    resolutions_json TEXT NOT NULL,
    screenshot_path TEXT,
    created_at TEXT NOT NULL
  );`,
  `ALTER TABLE jobs ADD COLUMN resume_used TEXT;
  ALTER TABLE jobs ADD COLUMN cover_letter_used TEXT;`,
  `ALTER TABLE jobs ADD COLUMN degrees TEXT;`,
  `ALTER TABLE job_blockers ADD COLUMN options_json TEXT;
  ALTER TABLE job_blockers ADD COLUMN field_label TEXT;
  ALTER TABLE job_blockers ADD COLUMN field_kind TEXT;`,
];
