-- 008 · Pipeline updates as activity (2026-10-11). Apply BEFORE deploying the code that uses it:
-- the settings save writes pipeline_activity. Old code ignores both changes.
-- Portable across MySQL 8 and MariaDB 10.2+. Two statements: if the first fails with
-- "Duplicate column", it was already applied — run the second one alone.
ALTER TABLE settings
  ADD COLUMN pipeline_activity TINYINT(1) NOT NULL DEFAULT 0 AFTER idle_minutes;
ALTER TABLE activity_events
  MODIFY kind ENUM('message','call','comment','other','pipeline') NOT NULL;
