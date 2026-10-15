CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- One row per record. Deletes are tombstones (deleted = 1) and are never removed.
-- An empty client push does not delete rows that were not sent.
CREATE TABLE IF NOT EXISTS records (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  payload TEXT,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS records_user ON records (user_id, updated_at);
