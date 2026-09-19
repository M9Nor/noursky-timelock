-- NourSky TimeClock — D1 schema (Phase 1)
-- All timestamps are UNIX seconds (UTC). Display conversion happens in the UI.

CREATE TABLE IF NOT EXISTS settings (
  location_id        TEXT PRIMARY KEY,
  timezone           TEXT    NOT NULL DEFAULT 'Asia/Riyadh',
  daily_target_hours REAL    NOT NULL DEFAULT 8,
  work_start         TEXT    DEFAULT '09:00',      -- HH:MM local, used later for lateness
  max_session_hours  REAL    NOT NULL DEFAULT 12,  -- auto-close threshold
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS employees (
  user_id     TEXT NOT NULL,
  location_id TEXT NOT NULL,
  name        TEXT,
  email       TEXT,
  role        TEXT NOT NULL CHECK (role IN ('manager','employee')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_sec INTEGER,
  closed_by    TEXT CHECK (closed_by IN ('user','auto','admin')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Guarantees one open session per employee per sub-account (double-click / multi-tab safe)
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_one_open
  ON sessions(user_id, location_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_sessions_loc_start ON sessions(location_id, started_at);
CREATE INDEX IF NOT EXISTS ix_sessions_user      ON sessions(user_id, location_id, started_at);

CREATE TABLE IF NOT EXISTS edits_log (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  editor_user_id  TEXT NOT NULL,
  old_started_at  INTEGER,
  old_ended_at    INTEGER,
  new_started_at  INTEGER,
  new_ended_at    INTEGER,
  reason          TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ix_edits_session ON edits_log(session_id);
