-- Black Fox Center database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS docs (
  path TEXT PRIMARY KEY,          -- e.g. projects/clear-men-expo, settings/app, owner/briefs/sessions/b123
  coll TEXT NOT NULL,             -- the collection part of the path
  id TEXT NOT NULL,               -- the last part of the path
  data TEXT,                      -- JSON
  updated_at INTEGER NOT NULL,    -- ms; every change gets a new stamp so open apps can pick it up
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at);
CREATE INDEX IF NOT EXISTS docs_coll ON docs (coll);

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  seen_at INTEGER
);

-- Each person's Google connection, encrypted with the TOKEN_KEY secret.
CREATE TABLE IF NOT EXISTS google_tokens (
  email TEXT PRIMARY KEY,
  refresh_enc TEXT NOT NULL,
  scope TEXT,
  updated_at INTEGER
);
