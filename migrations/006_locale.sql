-- 006 · Arabic / English. Company language (settings) and a personal override (employees).
-- Apply BEFORE deploying the bilingual code: login reads employees.locale. Old code ignores both.
-- Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN locale ENUM('ar','en') NOT NULL DEFAULT 'ar' AFTER timezone;
ALTER TABLE employees
  ADD COLUMN locale ENUM('ar','en') NULL AFTER role;
