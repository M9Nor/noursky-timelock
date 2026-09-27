-- 001 · Attendance policies phase 1: per-account lateness grace (minutes).
-- Applied to production on 2026-09-26, before the phase 1 deploy (6535ee5).
-- schema.sql already includes this column; run this only on a database created
-- from an older schema.sql. Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 15 AFTER work_start;
