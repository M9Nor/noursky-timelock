-- 003 · Break modes: off / fixed (manager window, paid or unpaid) / flexible (button).
-- Apply BEFORE deploying the break-modes code: it reads break_mode and breaks.kind.
-- Old code keeps working on the migrated schema (it only reads breaks_enabled, which
-- the new code keeps in sync). schema.sql already includes all of this.
-- Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN break_mode ENUM('off','fixed','flexible') NOT NULL DEFAULT 'off' AFTER breaks_enabled;
ALTER TABLE settings
  ADD COLUMN break_start CHAR(5) NULL AFTER break_mode;
ALTER TABLE settings
  ADD COLUMN break_end CHAR(5) NULL AFTER break_start;
ALTER TABLE settings
  ADD COLUMN break_paid TINYINT(1) NOT NULL DEFAULT 0 AFTER break_end;
-- Accounts that already switched breaks on keep the button they have today.
UPDATE settings SET break_mode = 'flexible' WHERE breaks_enabled = 1;

ALTER TABLE breaks
  ADD COLUMN kind ENUM('employee','fixed') NOT NULL DEFAULT 'employee' AFTER location_id;
-- One recorded row per session per fixed window; NULL for employee breaks, so the
-- UNIQUE key only constrains fixed rows (same generated-column trick as open_flag).
ALTER TABLE breaks
  ADD COLUMN fixed_key BIGINT GENERATED ALWAYS AS (IF(kind = 'fixed', started_at, NULL)) STORED;
ALTER TABLE breaks
  ADD UNIQUE KEY ux_fixed_window (session_id, fixed_key);
