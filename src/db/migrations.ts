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
  `ALTER TABLE job_blockers ADD COLUMN field_description TEXT;
  ALTER TABLE questions ADD COLUMN draft_basis TEXT;`,
  // AI cost: every LLM call (local ones too, at $0), cached LLM answers, and a counter that changes whenever the answer
  // bank's questions change (match results are cached per revision; a wording added to a matched question doesn't
  // change it, so the same form matched again is free). The background applier is turned off
  // for every install: it only runs once the user turns it on.
  `CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    task TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL,
    job_id TEXT
  );
  CREATE INDEX idx_llm_usage_at ON llm_usage (at);
  CREATE INDEX idx_llm_usage_job ON llm_usage (job_id);
  CREATE TABLE llm_cache (
    key TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    value_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE bank_revision (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
  INSERT INTO bank_revision (id, rev) VALUES (1, 0);
  CREATE TRIGGER bank_rev_q_insert AFTER INSERT ON questions BEGIN UPDATE bank_revision SET rev = rev + 1; END;
  CREATE TRIGGER bank_rev_q_delete AFTER DELETE ON questions BEGIN UPDATE bank_revision SET rev = rev + 1; END;
  CREATE TRIGGER bank_rev_q_update AFTER UPDATE OF canonical, kind, is_factual, options ON questions BEGIN UPDATE bank_revision SET rev = rev + 1; END;
  UPDATE kv SET value = json_set(value, '$.backgroundApplier', json('false')) WHERE key = 'settings' AND json_valid(value);`,
];
