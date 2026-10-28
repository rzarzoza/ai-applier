// Append-only: later tasks add new entries; never edit an earlier one.
export const migrations: string[] = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
