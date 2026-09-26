# NourSky TimeClock — Attendance Policies (Design Spec)

**Date:** 2026-09-24 · **Status:** approved, not yet implemented

## 1. Goal

Turn the tool from "works for our team" into a **standard attendance product** that
fits any GHL sub-account — office, remote, field or shift-based — **without changing
the core flow**. Everything company-specific becomes a setting the manager controls.

All users are GHL users (every client runs on GHL), so identity stays on SSO. No
second login path is needed or planned.

## 2. Unchanged core (already built and live)

```
employee opens "الدوام" in GHL  →  [ابدأ الدوام]  →  … work …  →  [إنهاء الدوام]
manager: live floor · report · session edit (reason required) · CSV · settings
```

Manual start/stop stays the record of truth. Rationale in DECISIONS.md: attendance
records feed payroll, so they must reflect a deliberate act; automatic tracking
measures "tab open", not work, and its failures are silent and employer-biased.

## 3. What each company type needs

| Type | Needs |
|---|---|
| Office | simplicity — start/stop only |
| Remote | light proof of work, without surveillance |
| Field | same flow; phone access (see §9) |
| Shift-based | expected start time + lateness |

The common core already covers all four. The differences are **policies**, not flows.

## 4. New settings (per `location_id`)

| Setting | Type | Default | Status |
|---|---|---|---|
| `timezone` | IANA string | `Asia/Riyadh` | exists |
| `daily_target_hours` | decimal | 8 | exists |
| `work_start` | `HH:MM` | `09:00` | **exists but unused — activate** |
| `max_session_hours` | decimal | 12 | exists |
| `late_grace_minutes` | int | 15 | **new** |
| `breaks_enabled` | bool | false | **new (phase 2)** |
| `note_on_stop` | enum `off/optional/required` | `off` | **new (phase 2)** |

## 5. Business rules

**5.1 Lateness.** A day is late when the employee's **first** session of that day
started after `work_start + late_grace_minutes`, evaluated in the location's
timezone. Counted only on days with attendance — there is no "absent" concept,
because absence requires a shift schedule and leave management (deferred, §9).
When `work_start` is NULL, lateness is not computed and the column shows `—`.

**5.2 Daily target on the employee screen.** The employee screen currently hardcodes
`DAILY_TARGET_SEC = 8 * 3600`, which contradicts the manager's setting. It must read
the location's real `daily_target_hours`. This is an existing defect, not a feature.

**5.3 Employee history.** The employee sees their own last 7 days: start, end, total,
and a flag when the session was auto-closed. Self-service visibility so a wrong entry
is caught by the employee, not discovered on payday.

**5.4 Breaks (phase 2).** A break pauses counting; it does not end the session.
`worked = session duration − Σ breaks`. Only one open break per open session.

**5.5 Note on stop (phase 2).** Short free text captured at stop, stored on the
session, shown to the manager in the sessions list and CSV. This is the
non-invasive proof-of-work mechanism for remote staff — chosen over screenshots or
activity tracking deliberately.

**5.6 Auto-close.** Unchanged: capped at `max_session_hours`, flagged `closed_by='auto'`,
surfaced to the manager via the existing `auto_closed` count for review.

## 6. Data model changes

**Phase 1** — additive only, no table changes:
```sql
ALTER TABLE settings ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 15;
```

**Phase 2:**
```sql
ALTER TABLE settings ADD COLUMN breaks_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN note_on_stop ENUM('off','optional','required') NOT NULL DEFAULT 'off';
ALTER TABLE sessions ADD COLUMN note VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS breaks (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  session_id  CHAR(36)    NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  started_at  BIGINT      NOT NULL,
  ended_at    BIGINT      NULL,
  open_flag   TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  UNIQUE KEY ux_one_open_break (session_id, open_flag),
  KEY ix_breaks_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

The `open_flag` trick mirrors `sessions` so "one open break per session" is enforced
by the database, not by application logic.

**Migration order is mandatory: database first, then code.** Deploys do not run
migrations; `schema.sql` changes are applied manually via phpMyAdmin. Shipping code
that reads a missing column breaks production immediately.

## 7. API changes

**Phase 1**
- `GET /me/settings` — new. Returns `daily_target_hours`, `timezone`, `work_start`
  for the caller's location. Employee-accessible (`authed`, not `managerOnly`).
- `GET /me/sessions?days=7` — new. The caller's own recent sessions.
- `GET /admin/report` — add `late_days` per employee.
- `PUT /admin/settings` — accept and validate `late_grace_minutes` (0–240).

**Phase 2**
- `POST /session/break/start`, `POST /session/break/stop`
- `POST /session/stop` — accept optional `note`
- `GET /admin/sessions` and `/admin/export.csv` — include `note`

Unchanged rules: `location_id` and `user_id` always come from `c.get("claims")`,
never from the request; every `/admin/*` route keeps `authed, managerOnly`.

## 8. Testing

- Vitest for every new component and changed screen (current suite: 36 tests, all green).
- `scripts/smoke-test.mjs` gains cases: lateness computed correctly around the grace
  boundary; `/me/settings` returns the location's values; `/me/sessions` returns only
  the caller's own rows; an employee cannot read another employee's sessions.
- Timezone correctness is the highest-risk area: lateness and "days present" are
  computed with an explicit offset, so tests must cover a non-UTC location.

## 9. Deferred (NOT in this work)

- Shift schedules, absence, leave and approvals
- GPS / geofence — clients are office and sales teams; adds privacy cost without value
- Automatic activity tracking — rejected, see §2
- Dark mode
- **Mobile verification**: whether the Custom Page renders inside the GHL mobile app
  is untested. If it does not, field and real-estate staff cannot clock in from a
  phone and this plan needs revisiting. **Test before phase 2.**
- Reminders: to be solved with the agency's own GHL Automation workflows (WhatsApp/SMS
  at `work_start` and at expected end), which needs no code at all.

## 10. Self-review

- No placeholders or TBDs.
- §5.1 fixes the ambiguity of "late" by pinning it to the first session, the location
  timezone, and an explicit NULL behavior.
- §6 states migration order explicitly because the deploy pipeline does not migrate.
- Phase 1 is deliberately additive so it can ship without touching the session model.
