-- NourSky TimeClock — MySQL / MariaDB schema (Hostinger)
-- All timestamps are UNIX seconds (UTC). Display conversion happens in the UI.
-- Run once via hPanel → Databases → phpMyAdmin → Import.

CREATE TABLE IF NOT EXISTS settings (
  location_id        VARCHAR(64)  NOT NULL PRIMARY KEY,
  timezone           VARCHAR(64)  NOT NULL DEFAULT 'Asia/Riyadh',
  daily_target_hours DECIMAL(4,2) NOT NULL DEFAULT 8,
  work_start         CHAR(5)      NULL DEFAULT '09:00',
  late_grace_minutes INT          NOT NULL DEFAULT 15,
  breaks_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  note_on_stop       ENUM('off','optional','required') NOT NULL DEFAULT 'off',
  break_mode         ENUM('off','fixed','flexible') NOT NULL DEFAULT 'off',
  break_start        CHAR(5)      NULL,
  break_end          CHAR(5)      NULL,
  break_paid         TINYINT(1)   NOT NULL DEFAULT 0,
  -- When the break policy last changed; fixed windows that began earlier are never recorded.
  break_policy_since BIGINT       NULL,
  activity_monitoring       TINYINT(1)  NOT NULL DEFAULT 0,
  idle_minutes              INT         NOT NULL DEFAULT 30,
  activity_monitoring_since BIGINT      NULL,
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
  note         VARCHAR(500) NULL,
  activity_count   INT         NULL,
  last_activity_at BIGINT      NULL,
  longest_idle_sec INT         NULL,
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

CREATE TABLE IF NOT EXISTS breaks (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  session_id  CHAR(36)    NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  kind        ENUM('employee','fixed') NOT NULL DEFAULT 'employee',
  started_at  BIGINT      NOT NULL,
  ended_at    BIGINT      NULL,
  -- 1 while the break is open, NULL once ended → one open break per session.
  open_flag   TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  -- Started_at for fixed rows, NULL for employee breaks: one row per session per window.
  fixed_key   BIGINT GENERATED ALWAYS AS (IF(kind = 'fixed', started_at, NULL)) STORED,
  UNIQUE KEY ux_one_open_break (session_id, open_flag),
  UNIQUE KEY ux_fixed_window (session_id, fixed_key),
  KEY ix_breaks_session (session_id),
  -- Covers autoCloseStale's per-location "close still-open breaks" UPDATE, which
  -- filters on (location_id, ended_at IS NULL) on every request.
  KEY ix_breaks_loc_open (location_id, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ghl_installs (
  location_id       VARCHAR(64)   NOT NULL PRIMARY KEY,
  company_id        VARCHAR(64)   NULL,
  access_token_enc  TEXT          NULL,
  refresh_token_enc TEXT          NULL,
  token_expires_at  BIGINT        NULL,
  scopes            VARCHAR(1000) NULL,
  installed_at      BIGINT        NULL,
  uninstalled_at    BIGINT        NULL,
  last_event_at     BIGINT        NULL,
  updated_at        BIGINT        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Metadata only: never the content of a message or call.
CREATE TABLE IF NOT EXISTS activity_events (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  location_id  VARCHAR(64)  NOT NULL,
  user_id      VARCHAR(64)  NULL,
  occurred_at  BIGINT       NOT NULL,
  kind         ENUM('message','call','comment','other') NOT NULL,
  message_type VARCHAR(40)  NULL,
  source       VARCHAR(60)  NULL,
  webhook_id   VARCHAR(100) NOT NULL,
  created_at   BIGINT       NOT NULL,
  UNIQUE KEY ux_activity_webhook (webhook_id),
  KEY ix_activity_user_time (location_id, user_id, occurred_at),
  KEY ix_activity_time (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_alerts (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  location_id      VARCHAR(64)  NOT NULL,
  user_id          VARCHAR(64)  NOT NULL,
  session_id       CHAR(36)     NULL,
  kind             ENUM('idle','working_not_clocked_in') NOT NULL,
  from_at          BIGINT       NOT NULL,
  to_at            BIGINT       NULL,
  detected_at      BIGINT       NOT NULL,
  status           ENUM('open','resolved','dismissed') NOT NULL DEFAULT 'open',
  resolution       ENUM('dismissed','ended_at_last_activity','clocked_in','late_activity') NULL,
  resolved_by      VARCHAR(64)  NULL,
  resolved_at      BIGINT       NULL,
  employee_note    VARCHAR(300) NULL,
  employee_note_at BIGINT       NULL,
  -- One ongoing idle stretch per session; one open not-clocked-in alert per employee.
  -- 1 while the alert is that kind of open, NULL otherwise (numeric flag, like sessions.open_flag:
  -- ERROR 1901 was observed on MariaDB 11.8 for string-valued IF() in a STORED generated column).
  -- UNIQUE allows many NULLs.
  idle_open_flag   TINYINT GENERATED ALWAYS AS
                     (IF(kind = 'idle' AND status = 'open' AND to_at IS NULL, 1, NULL)) STORED,
  nci_open_flag    TINYINT GENERATED ALWAYS AS
                     (IF(kind = 'working_not_clocked_in' AND status = 'open', 1, NULL)) STORED,
  UNIQUE KEY ux_alert_idle_open (session_id, idle_open_flag),
  UNIQUE KEY ux_alert_nci_open (location_id, user_id, nci_open_flag),
  KEY ix_alert_loc_status (location_id, status),
  KEY ix_alert_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
