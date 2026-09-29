-- 004 · Activity monitoring (phase A creates everything phases A and B need).
-- Apply BEFORE deploying the activity-monitoring code. Old code keeps working on the
-- migrated schema (new columns have defaults; new tables are unused by it).
-- schema.sql already includes all of this. Written to be portable across MySQL 8 and MariaDB 10.2+;
-- run end to end on a pre-004 schema on MySQL 8.0.46 and MariaDB 11.8.9 (10.2 not tested).
-- Several statements, not re-runnable as a whole: if it stops midway, check
-- SHOW COLUMNS / SHOW TABLES and run only the remaining statements.
ALTER TABLE settings
  ADD COLUMN activity_monitoring TINYINT(1) NOT NULL DEFAULT 0 AFTER break_policy_since;
ALTER TABLE settings
  ADD COLUMN idle_minutes INT NOT NULL DEFAULT 30 AFTER activity_monitoring;
ALTER TABLE settings
  ADD COLUMN activity_monitoring_since BIGINT NULL AFTER idle_minutes;

ALTER TABLE sessions
  ADD COLUMN activity_count INT NULL AFTER note;
ALTER TABLE sessions
  ADD COLUMN last_activity_at BIGINT NULL AFTER activity_count;
ALTER TABLE sessions
  ADD COLUMN longest_idle_sec INT NULL AFTER last_activity_at;

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
