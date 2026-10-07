-- 007 · Early-leave approval (spec 2026-10-07). Apply BEFORE deploying the code that uses it:
-- /session/stop and the settings read the new column. Old code ignores all three changes.
-- Portable across MySQL 8 and MariaDB 10.2+. Several statements: if one fails, check what exists
-- (SHOW COLUMNS FROM settings LIKE 'early_leave%'; SHOW TABLES LIKE 'early_leave%';) and run the rest.
ALTER TABLE settings
  ADD COLUMN early_leave_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER note_on_stop;
ALTER TABLE sessions
  MODIFY closed_by ENUM('user','auto','admin','approved') NULL;
CREATE TABLE IF NOT EXISTS early_leave_requests (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  location_id   VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(64)  NOT NULL,
  session_id    CHAR(36)     NOT NULL,
  reason        VARCHAR(300) NOT NULL,
  requested_at  BIGINT       NOT NULL,
  work_end_at   BIGINT       NOT NULL,
  status        ENUM('pending','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'pending',
  decided_by    VARCHAR(64)  NULL,
  decided_at    BIGINT       NULL,
  manager_note  VARCHAR(300) NULL,
  pending_flag  TINYINT GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED,
  UNIQUE KEY ux_early_leave_pending (session_id, pending_flag),
  KEY ix_early_leave_loc_time (location_id, requested_at),
  KEY ix_early_leave_user_time (location_id, user_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
