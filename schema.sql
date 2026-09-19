-- NourSky TimeClock — MySQL / MariaDB schema (Hostinger)
-- All timestamps are UNIX seconds (UTC). Display conversion happens in the UI.
-- Run once via hPanel → Databases → phpMyAdmin → Import.

CREATE TABLE IF NOT EXISTS settings (
  location_id        VARCHAR(64)  NOT NULL PRIMARY KEY,
  timezone           VARCHAR(64)  NOT NULL DEFAULT 'Asia/Riyadh',
  daily_target_hours DECIMAL(4,2) NOT NULL DEFAULT 8,
  work_start         CHAR(5)      NULL DEFAULT '09:00',
  max_session_hours  DECIMAL(4,2) NOT NULL DEFAULT 12,
  updated_at         BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
  user_id     VARCHAR(64)  NOT NULL,
  location_id VARCHAR(64)  NOT NULL,
  name        VARCHAR(255) NULL,
  email       VARCHAR(255) NULL,
  role        ENUM('manager','employee') NOT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  PRIMARY KEY (user_id, location_id),
  KEY ix_emp_loc (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id           CHAR(36)    NOT NULL PRIMARY KEY,
  user_id      VARCHAR(64) NOT NULL,
  location_id  VARCHAR(64) NOT NULL,
  started_at   BIGINT      NOT NULL,
  ended_at     BIGINT      NULL,
  duration_sec BIGINT      NULL,
  closed_by    ENUM('user','auto','admin') NULL,
  created_at   BIGINT      NOT NULL,
  -- 1 while the session is open, NULL once closed. UNIQUE allows many NULLs,
  -- so this enforces "one open session per employee per sub-account".
  open_flag    TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  UNIQUE KEY ux_one_open (user_id, location_id, open_flag),
  KEY ix_loc_start (location_id, started_at),
  KEY ix_user_start (user_id, location_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS edits_log (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  session_id     CHAR(36)     NOT NULL,
  location_id    VARCHAR(64)  NOT NULL,
  editor_user_id VARCHAR(64)  NOT NULL,
  old_started_at BIGINT       NULL,
  old_ended_at   BIGINT       NULL,
  new_started_at BIGINT       NULL,
  new_ended_at   BIGINT       NULL,
  reason         VARCHAR(500) NOT NULL,
  created_at     BIGINT       NOT NULL,
  KEY ix_edits_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
