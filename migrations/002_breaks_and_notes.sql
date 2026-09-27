-- 002 · Attendance policies phase 2: breaks and note on stop.
-- Apply BEFORE deploying the phase 2 code: every worked-time query reads `breaks`,
-- so the new code on an unmigrated database returns 500 on /me/status and /admin/report.
-- schema.sql already includes all of this; run this only on an existing database.
-- Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN breaks_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER late_grace_minutes;
ALTER TABLE settings
  ADD COLUMN note_on_stop ENUM('off','optional','required') NOT NULL DEFAULT 'off' AFTER breaks_enabled;
ALTER TABLE sessions
  ADD COLUMN note VARCHAR(500) NULL AFTER closed_by;

CREATE TABLE IF NOT EXISTS breaks (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  session_id  CHAR(36)    NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  started_at  BIGINT      NOT NULL,
  ended_at    BIGINT      NULL,
  -- 1 while the break is open, NULL once ended: UNIQUE allows many NULLs, so the
  -- database itself enforces "one open break per session" (same trick as sessions).
  open_flag   TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  UNIQUE KEY ux_one_open_break (session_id, open_flag),
  KEY ix_breaks_session (session_id),
  KEY ix_breaks_loc (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
