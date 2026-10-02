-- 005 · Working hours for activity alerts (phase B): end of the working day and the
-- working weekdays. Apply BEFORE deploying activity monitoring phase B; old code ignores
-- both columns. schema.sql already includes them. Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN work_end CHAR(5) NULL AFTER work_start;
-- Bitmask of working weekdays in the location's timezone: bit 0 = Sunday … bit 6 = Saturday.
ALTER TABLE settings
  ADD COLUMN work_days TINYINT UNSIGNED NOT NULL DEFAULT 127 AFTER work_end;
