# Database migrations

`schema.sql` is always the **full current schema** — use it for a fresh database.
The files here upgrade an **existing** database that was created from an older
`schema.sql`. Run each file once, in numeric order, via hPanel → Databases →
phpMyAdmin → SQL, then record it below.

Rules (from `CLAUDE.md`): every statement must run on both MySQL 8 and MariaDB 10.2+,
so no `ADD COLUMN IF NOT EXISTS` (MariaDB-only). A file that fails with
"Duplicate column" was already applied — record it and move on.

**Deploy order:** apply the migration **before** pushing the code that reads the new
column. The API's `/health` stays green on an old schema, so a missing column only
shows up as 500s on the routes that touch it.

When adding a column: add it to `schema.sql` **and** add the next numbered file here.

## Applied

| File | Production | Notes |
|---|---|---|
| `001_late_grace_minutes.sql` | 2026-09-26 | run manually in phpMyAdmin before phase 1 deploy |
| `002_breaks_and_notes.sql` | 2026-09-27 | run manually in phpMyAdmin before phase 2 deploy |
