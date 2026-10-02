# Activity Monitoring — Phase B (Detection, Alerts & UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the manager when an employee is working in GHL during working hours without having clocked in (an alert the manager can dismiss and the employee can answer), and show idle time as information — a live-floor chip and per-session activity columns — never as an alert.

**Architecture:** Migration 005 adds `settings.work_end` and `settings.work_days`. A new pure module `src/activity.js` holds every rule (working hours in the location's timezone, event freshness, idle seconds with breaks removed, session summary) and is unit-tested without a database, like `src/tz.js`. `src/server.js` opens the alert inside `POST /webhooks/events` when an event is stored (no detector timer), computes idle time when `/admin/live` is read, stores session summaries through one function every close path reaches, and gains `/admin/alerts` and `/me/alerts`. The React app gets the new settings fields, an alerts panel, live-floor chips, session columns and an employee banner.

**Tech Stack:** Node 20 ESM · Hono 4 · mysql2 · `node:test` · React 18 · Vitest 2 · MariaDB locally (Docker container `timeclock-db`)

**Spec:** `docs/superpowers/specs/2026-09-29-activity-monitoring-design.md` — revised 2026-10-02. Phase B = the revision note at the top, §2.1, §4.2 (migration 005), §5.3–§5.6, §6, §7, §8 "Phase B", §9 "Phase B", §11.

## Global Constraints

- Plain ESM JavaScript, 2-space indent, semicolons. **No new npm dependencies.**
- SQL must run on **both MySQL 8 and MariaDB 10.2+**: no `ADD COLUMN IF NOT EXISTS`, no `RETURNING`, no `INSERT … AS alias`, no partial indexes. Upserts use `VALUES(col)`.
- `location_id` / `user_id` on authenticated routes come only from `c.get("claims")`. Every `/admin/*` route uses `authed, managerOnly`. An alert id from the URL is always matched together with the caller's `location_id` (and, for employees, `user_id`).
- **Activity never changes hours.** Nothing in this plan starts, stops, shortens or back-dates a session.
- **Only events with a `user_id` count as a person's activity** (spec §2.1). Rows without one are kept but never used.
- The not-clocked-in alert is for `role = 'employee'` users that exist in `employees` (opened TimeClock at least once). Managers never get it.
- Working hours = `work_start`…`work_end` (end exclusive) on a `work_days` weekday, in the location's timezone. `work_end` NULL (the default) or `work_start` NULL → no alerts. Same-day hours only (`work_start < work_end`).
- `work_days` bitmask: bit 0 = Sunday, 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday, 5 = Friday, 6 = Saturday. Allowed 1–127, default 127.
- An event opens an alert only when `occurred_at` is between `now − 6 h` and `now + 5 min`.
- Idle is shown only when monitoring is on **and** the location's newest `activity_events` row is less than 24 h old (outage guard). `ghl_installs.last_event_at` is **not** used for this.
- `PUT /admin/settings`: **a field absent from the body keeps its stored value**, for every field. `null` / `""` keep their current meaning (cleared, or the documented default).
- Errors: `{ error: "CODE" }` via `HttpError`. New codes: `INVALID_WORK_END` (400), `INVALID_WORK_DAYS` (400), `ALERT_NOT_FOUND` (404), `INVALID_STATUS` (400). Employee alert notes reuse `NOTE_REQUIRED` (400, empty) and `NOTE_TOO_LONG` (400, over 300 characters). Every new code goes into `PROJECT.md` §8.
- UI: Arabic, RTL, Western digits, class-based CSS tokens from `web/src/styles.css`. Times shown in the **location's** timezone.
- Migration order: `migrations/005_working_hours.sql` is applied to production in phpMyAdmin **before** this code is pushed.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deliberate refinements of the spec

1. `GET /admin/alerts` accepts `status` = `open` (default) | `resolved` | `dismissed`; anything else → `400 INVALID_STATUS`. Both alert lists also return the location `timezone` and `server_time`.
2. Employee alert notes: empty → `400 NOTE_REQUIRED`; over 300 → `400 NOTE_TOO_LONG`; not the caller's open alert → `404 ALERT_NOT_FOUND`.
3. Session summaries are written by one function, `summarizeClosedSessions(loc)`, which fills recently closed sessions (last 7 days) whose summary is NULL. `/session/stop`, `autoCloseStale` and `PATCH /admin/sessions/:id` (which clears the summary first) all reach it. A session that closed while monitoring is off keeps NULL ("—").
4. `/admin/live` also returns `idle_minutes` (NULL when monitoring is off) so the chip threshold is the manager's setting.
5. Idle and summaries subtract every break: employee breaks, recorded fixed rows, and the fixed window itself (paid windows too — a paid lunch is still not activity).

## Shared commands

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock

# local DB (MariaDB in Docker)
docker start timeclock-db

# apply a migration locally
set -a; . ./.env; set +a
docker exec -i timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/005_working_hours.sql

# restart the local API after changing src/
pkill -f "node --env-file=.env src/server.js"; nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health >/dev/null; do sleep 1; done; echo up

# smoke (DB + API up). node --env-file gives the smoke test the local DB credentials.
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|SKIP|passed"

npm run test:unit                      # node:test
cd web && npx vitest run               # frontend
```

**Baseline before Task 1:** smoke **117 passed, 0 failed**; unit **40**; frontend **99**. Local `.env` has `NODE_ENV=development` (the smoke test's webhook key is accepted) and no `GHL_APP_ID`.

## File map

| File | Change |
|---|---|
| `migrations/005_working_hours.sql`, `migrations/README.md`, `schema.sql` | `work_end`, `work_days` (T1) |
| `src/server.js` | settings PUT "absent = keep" + new fields (T1); alert on event arrival, `GHL_APP_ID` trim, `GET /admin/alerts`, resolve on clock-in (T3); dismiss, `/me/alerts`, note (T4); live idle, summaries, sessions/CSV columns, connection extras, `/me/status` flag (T5) |
| `src/activity.js`, `src/activity.test.mjs` | new — pure rules (T2) |
| `package.json` | `test:unit` adds `src/activity.test.mjs` (T2) |
| `scripts/smoke-test.mjs` | checks per server task (T1, T3, T4, T5) |
| `PROJECT.md` | §7 settings, §8 routes and error codes (T1, T3, T4, T5) |
| `web/src/time.js`, `web/src/time.test.js` | `formatTime`, `formatIdle` (T6) |
| `web/src/components/SettingsPanel.jsx` (+ test) | work end, work days, hints (T6) |
| `web/src/components/AlertsPanel.jsx` (+ test), `ManagerDashboard.jsx` | new panel (T7) |
| `web/src/components/LiveFloor.jsx` (+ test), `ReportPanel.jsx` (+ test), `web/src/styles.css` | chips and columns (T7) |
| `web/src/components/EmployeeScreen.jsx` (+ test) | banner, note, monitoring line (T8) |
| `CLAUDE.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md` | handoff (T9) |

---

### Task 1: Migration 005 and the settings API ("absent = keep", working hours)

**Files:**
- Create: `migrations/005_working_hours.sql`
- Modify: `migrations/README.md`, `schema.sql:9`, `src/server.js:887-959` (`PUT /admin/settings`), `scripts/smoke-test.mjs`, `PROJECT.md` (§7 `settings`, §8 PUT row and error table)

**Interfaces:**
- Produces: `settings.work_end` (`"HH:MM"` | null), `settings.work_days` (integer 1–127); `GET`/`PUT /admin/settings` return both (via `SELECT *`). `PUT` keeps any absent field.

- [ ] **Step 1: Write the migration**

`migrations/005_working_hours.sql`:

```sql
-- 005 · Working hours for activity alerts (phase B): end of the working day and the
-- working weekdays. Apply BEFORE deploying activity monitoring phase B; old code ignores
-- both columns. schema.sql already includes them. Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN work_end CHAR(5) NULL AFTER work_start;
-- Bitmask of working weekdays in the location's timezone: bit 0 = Sunday … bit 6 = Saturday.
ALTER TABLE settings
  ADD COLUMN work_days TINYINT UNSIGNED NOT NULL DEFAULT 127 AFTER work_end;
```

In `schema.sql`, right after the `work_start` line, add:

```sql
  work_end           CHAR(5)      NULL,
  -- Working weekdays, bit 0 = Sunday … bit 6 = Saturday (127 = every day).
  work_days          TINYINT UNSIGNED NOT NULL DEFAULT 127,
```

In `migrations/README.md`, add to the **Applied** table:

```markdown
| `005_working_hours.sql` | _pending_ | run manually in phpMyAdmin before activity monitoring phase B deploy |
```

- [ ] **Step 2: Apply locally and check**

```bash
docker start timeclock-db
set -a; . ./.env; set +a
docker exec -i timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/005_working_hours.sql
docker exec timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "SHOW COLUMNS FROM settings LIKE 'work_%';"
```

Expected: `work_start`, `work_end` (char(5), NULL), `work_days` (tinyint(3) unsigned, default 127).

- [ ] **Step 3: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, find the break-modes check that relied on an omitted window meaning "no window":

```js
check("fixed mode without a window → 400",
  (await fxPolicy({ break_mode: "fixed" })).body?.error === "INVALID_BREAK_WINDOW");
```

and send the cleared window explicitly (an absent field now keeps the stored 13:00–14:00):

```js
check("fixed mode without a window → 400",
  (await fxPolicy({ break_mode: "fixed", break_start: null, break_end: null })).body?.error === "INVALID_BREAK_WINDOW");
```

Then, immediately before the line `// --- Activity monitoring (phase A): settings, connection status, webhooks, OAuth. ---`, add:

```js
// --- Working hours and "absent = keep" (activity phase B, spec §4.2 / §5.4). Own location.
const WHLOC = `${LOC}-wh`;
const whMgr = await sso({ userId: `${WHLOC}-m1`, role: "admin", type: "account", activeLocation: WHLOC, userName: "مدير الدوام", email: "whm@x.com" });
const WHM = whMgr.body?.token;
const whDefaults = await call(WHM, "GET", "/admin/settings");
check("working hours default to no end and every day",
  whDefaults.body?.work_end === null && whDefaults.body?.work_days === 127,
  `(${JSON.stringify({ e: whDefaults.body?.work_end, d: whDefaults.body?.work_days })})`);
const whSaved = await call(WHM, "PUT", "/admin/settings",
  { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", work_end: "17:30", work_days: 95, idle_minutes: 45 });
check("work_end and work_days are saved",
  whSaved.status === 200 && whSaved.body?.work_end === "17:30" && whSaved.body?.work_days === 95,
  `(${whSaved.status} ${JSON.stringify(whSaved.body)})`);
const whKeep = await call(WHM, "PUT", "/admin/settings", { late_grace_minutes: 20 });
check("a field absent from the body keeps its stored value",
  whKeep.status === 200 && whKeep.body?.late_grace_minutes === 20 && whKeep.body?.timezone === "Asia/Riyadh"
    && whKeep.body?.work_start === "09:00" && whKeep.body?.work_end === "17:30" && whKeep.body?.work_days === 95
    && whKeep.body?.idle_minutes === 45,
  `(${whKeep.status} ${JSON.stringify(whKeep.body)})`);
check("work_end before work_start → 400",
  (await call(WHM, "PUT", "/admin/settings", { work_end: "08:00" })).body?.error === "INVALID_WORK_END");
check("work_end equal to work_start → 400",
  (await call(WHM, "PUT", "/admin/settings", { work_end: "09:00" })).body?.error === "INVALID_WORK_END");
check("malformed work_end → 400",
  (await call(WHM, "PUT", "/admin/settings", { work_end: "5pm" })).body?.error === "INVALID_WORK_END");
check("moving work_start past the stored work_end → 400",
  (await call(WHM, "PUT", "/admin/settings", { work_start: "18:00" })).body?.error === "INVALID_WORK_END");
check("work_days 0 → 400", (await call(WHM, "PUT", "/admin/settings", { work_days: 0 })).body?.error === "INVALID_WORK_DAYS");
check("work_days 128 → 400", (await call(WHM, "PUT", "/admin/settings", { work_days: 128 })).body?.error === "INVALID_WORK_DAYS");
check("non-integer work_days → 400", (await call(WHM, "PUT", "/admin/settings", { work_days: "95" })).body?.error === "INVALID_WORK_DAYS");
const whCleared = await call(WHM, "PUT", "/admin/settings", { work_end: null });
check("work_end can be cleared with null", whCleared.body?.work_end === null, `(${JSON.stringify(whCleared.body?.work_end)})`);
await cleanupLocation(WHLOC);
```

- [ ] **Step 4: Run the smoke test to see the new checks fail**

Restart the API (shared commands), then run the smoke test.
Expected: FAIL on "work_end and work_days are saved" and "a field absent from the body keeps its stored value" (and the validation checks), everything else PASS.

- [ ] **Step 5: Rewrite `PUT /admin/settings` with "absent = keep"**

In `src/server.js`, replace the body of `app.put("/admin/settings", …)` from `const b = (await c.req.json()…` down to (and including) the closing `);` of the big `UPDATE settings` statement with:

```js
  const b = (await c.req.json().catch(() => null)) ?? {};
  // A field absent from the body keeps its stored value (spec §5.4): a page running an older
  // bundle does not know newer fields and must not reset them. null / "" keep their meaning
  // (a cleared value, or the documented default).
  const cur = (await getSettings(loc)) ?? {};
  const has = (k) => b[k] !== undefined;
  const pick = (k) => (has(k) ? b[k] : cur[k]);

  const timezone = pick("timezone");
  if (!timezone) throw new HttpError(400, "INVALID_TIMEZONE");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new HttpError(400, "INVALID_TIMEZONE"); }
  const target = Number(pick("daily_target_hours")), max = Number(pick("max_session_hours"));
  if (!(target > 0 && target <= 24) || !(max >= 1 && max <= 24)) throw new HttpError(400, "INVALID_HOURS");
  const workStart = (has("work_start") ? b.work_start : cur.work_start) || null;
  if (workStart && !HHMM.test(workStart)) throw new HttpError(400, "INVALID_WORK_START");
  // Same-day hours only; zero-padded HH:MM compares correctly as strings.
  const workEnd = (has("work_end") ? b.work_end : cur.work_end) || null;
  if (workEnd && (!HHMM.test(workEnd) || (workStart && workEnd <= workStart))) {
    throw new HttpError(400, "INVALID_WORK_END");
  }
  const workDays = has("work_days") ? b.work_days : (cur.work_days ?? 127);
  if (!Number.isInteger(workDays) || workDays < 1 || workDays > 127) throw new HttpError(400, "INVALID_WORK_DAYS");
  // null / "" grace means the 15-minute default: an emptied UI field arrives as "" and
  // Number("") === 0, which would silently mean "late one second after work_start".
  const rawGrace = pick("late_grace_minutes");
  const grace = rawGrace === undefined || rawGrace === null || rawGrace === "" ? 15 : Number(rawGrace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new HttpError(400, "INVALID_GRACE");
  if (has("breaks_enabled") && typeof b.breaks_enabled !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  // A stale tab running a much older bundle sends only breaks_enabled; map it so saving
  // there keeps a flexible-break policy instead of silently switching breaks off.
  const breakMode = b.break_mode
    ?? (has("breaks_enabled") ? (b.breaks_enabled ? "flexible" : "off") : (cur.break_mode ?? "off"));
  if (!BREAK_MODES.includes(breakMode)) throw new HttpError(400, "INVALID_BREAK_MODE");
  const breakStart = (has("break_start") ? b.break_start : cur.break_start) || null;
  const breakEnd = (has("break_end") ? b.break_end : cur.break_end) || null;
  if ((breakStart && !HHMM.test(breakStart)) || (breakEnd && !HHMM.test(breakEnd))) {
    throw new HttpError(400, "INVALID_BREAK_WINDOW");
  }
  if (breakMode === "fixed" && (!breakStart || !breakEnd || breakStart >= breakEnd)) {
    throw new HttpError(400, "INVALID_BREAK_WINDOW");
  }
  const breakPaid = has("break_paid") ? b.break_paid : Boolean(cur.break_paid);
  if (typeof breakPaid !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  const notePolicy = pick("note_on_stop") ?? "off";
  if (!NOTE_POLICIES.includes(notePolicy)) throw new HttpError(400, "INVALID_NOTE_POLICY");
  if (has("activity_monitoring") && typeof b.activity_monitoring !== "boolean") {
    throw new HttpError(400, "INVALID_ACTIVITY_MONITORING");
  }
  const monitoring = has("activity_monitoring") ? b.activity_monitoring : Boolean(cur.activity_monitoring);
  // Same empty-field rule as the grace: "" / null mean the 30-minute default.
  const rawIdle = pick("idle_minutes");
  const idleMinutes = rawIdle === undefined || rawIdle === null || rawIdle === "" ? 30 : Number(rawIdle);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 10 || idleMinutes > 240) {
    throw new HttpError(400, "INVALID_IDLE_MINUTES");
  }

  // break_policy_since moves to now only when the break policy itself changes. It is
  // assigned FIRST so it compares against the stored values: MySQL evaluates single-table
  // SET assignments left to right (MariaDB may use the old values throughout) — both see
  // the old break_* columns here. One statement, so no read-then-write race.
  await q(
    `UPDATE settings SET break_policy_since = IF(break_mode <=> :breakMode AND break_start <=> :breakStart
                                                  AND break_end <=> :breakEnd AND break_paid <=> :breakPaid,
                                                  break_policy_since, :t),
                         activity_monitoring_since = IF(activity_monitoring = 0 AND :monitoring = 1,
                                                        :t, activity_monitoring_since),
                         timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         work_end = :we, work_days = :wd,
                         late_grace_minutes = :grace, max_session_hours = :max,
                         breaks_enabled = :breaksEnabled, break_mode = :breakMode,
                         break_start = :breakStart, break_end = :breakEnd, break_paid = :breakPaid,
                         activity_monitoring = :monitoring, idle_minutes = :idleMinutes,
                         note_on_stop = :notePolicy, updated_at = :t
      WHERE location_id = :loc`,
    {
      tz: timezone, target, ws: workStart, we: workEnd, wd: workDays, grace, max,
      // Kept in sync so code that still reads breaks_enabled behaves the same.
      breaksEnabled: breakMode === "flexible" ? 1 : 0, breakMode, breakStart, breakEnd,
      breakPaid: breakPaid ? 1 : 0, notePolicy, t: now(), loc,
      monitoring: monitoring ? 1 : 0, idleMinutes,
    }
  );
```

Keep the lines before it (`const { loc } = …`, `await recordOpenFixedBreaks(loc);`) and after it (`return c.json(await getSettings(loc));`) unchanged. Note: the old comment "PUT replaces the whole policy: an omitted field means the default" is gone — that rule no longer holds.

- [ ] **Step 6: Run the smoke test**

Restart the API, run the smoke test. Expected: **0 failed**, and the count is the baseline 117 + 11 new = **128 passed**. If an older check fails because it omitted a field and expected the default, change that check to send the field explicitly (as in Step 3) — never weaken the server rule.

- [ ] **Step 7: Document**

In `PROJECT.md` §7 (`settings` table description), add the two columns: `work_end` (`HH:MM` أو NULL، نهاية الدوام بتوقيت الحساب) and `work_days` (bitmask أيام الدوام، bit 0 = الأحد … bit 6 = السبت، افتراضي 127 = كل الأيام).
In §8, in the `PUT /admin/settings` row: add `work_end` (`HH:MM` أو `null`، لازم بعد `work_start`) and `work_days` (1–127) to the body list, and replace "الحقل الناقص = القيمة الافتراضية" with "الحقل الناقص من الـ body بيضل متل ما هو (`null` أو `""` = فاضي أو القيمة الافتراضية)".
In the error table add:

```markdown
| `INVALID_WORK_END` | 400 | نهاية الدوام مش `HH:MM` أو مش بعد البداية | نهاية الدوام غير صحيحة (لازم تكون بعد البداية) |
| `INVALID_WORK_DAYS` | 400 | أيام الدوام مش رقم صحيح بين 1 و127 | اختار يوم دوام واحد على الأقل |
```

- [ ] **Step 8: Commit**

```bash
git add migrations/005_working_hours.sql migrations/README.md schema.sql src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(settings): working-day end and weekdays; an absent field keeps its value

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `src/activity.js` — the pure rules

**Files:**
- Create: `src/activity.js`, `src/activity.test.mjs`
- Modify: `package.json` (`test:unit`)

**Interfaces:**
- Consumes: `localDate(tz, ts)`, `wallToUtc(tz, {y,m,d}, "HH:MM")` from `src/tz.js`.
- Produces (all exported from `src/activity.js`):
  - `ALL_DAYS = 127`, `ALERT_MAX_AGE_SEC = 21600`, `ALERT_MAX_SKEW_SEC = 300`
  - `localWeekday(tz: string, ts: number): number` (0 = Sunday)
  - `isWithinWorkHours(st: {timezone, work_start, work_end, work_days} | null, ts: number): boolean`
  - `isFreshEvent(occurredAt: number, now: number): boolean`
  - `activeSeconds(from: number, until: number, breaks?: Array<[number, number|null]>): number`
  - `lastActivityAt({ startedAt, monitoringSince?, lastEventAt? }): number`
  - `idleSeconds({ startedAt, monitoringSince?, lastEventAt?, now, breaks? }): number`
  - `sessionSummary({ startedAt, endedAt, monitoringSince, eventTimes?, breaks? }): { activity_count, last_activity_at, longest_idle_sec } | null`

- [ ] **Step 1: Write the failing tests**

`src/activity.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_DAYS, localWeekday, isWithinWorkHours, isFreshEvent, activeSeconds, lastActivityAt, idleSeconds, sessionSummary,
} from "./activity.js";

const utc = (...a) => Date.UTC(...a) / 1000;
const DUBAI = { timezone: "Asia/Dubai", work_start: "09:00", work_end: "17:00", work_days: ALL_DAYS };

test("localWeekday uses the location's date, not UTC's", () => {
  // 2026-10-04 21:30Z is Sunday in UTC but already Monday 01:30 in Dubai (UTC+4).
  assert.equal(localWeekday("UTC", utc(2026, 9, 4, 21, 30)), 0);
  assert.equal(localWeekday("Asia/Dubai", utc(2026, 9, 4, 21, 30)), 1);
});

test("isWithinWorkHours: start is inclusive, end is exclusive, in local time", () => {
  // Monday 2026-10-05; 09:00 Dubai = 05:00Z, 17:00 Dubai = 13:00Z.
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 5, 0, 0)), true);
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 4, 59, 59)), false);
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 12, 59, 59)), true);
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 13, 0, 0)), false);
});

test("isWithinWorkHours follows a DST change (Europe/Berlin 09:00–17:00)", () => {
  const berlin = { timezone: "Europe/Berlin", work_start: "09:00", work_end: "17:00", work_days: ALL_DAYS };
  // 07:30Z is 08:30 CET on Friday 2026-03-27 but 09:30 CEST on Monday 2026-03-30.
  assert.equal(isWithinWorkHours(berlin, utc(2026, 2, 27, 7, 30)), false);
  assert.equal(isWithinWorkHours(berlin, utc(2026, 2, 30, 7, 30)), true);
});

test("isWithinWorkHours skips days off, judged by the local weekday", () => {
  const noFriday = { ...DUBAI, work_days: ALL_DAYS & ~(1 << 5) };
  assert.equal(isWithinWorkHours(noFriday, utc(2026, 9, 2, 6, 0)), false); // Fri 10:00 Dubai
  assert.equal(isWithinWorkHours(noFriday, utc(2026, 9, 1, 6, 0)), true);  // Thu 10:00 Dubai
  const allDay = { timezone: "Asia/Dubai", work_start: "00:00", work_end: "23:59" };
  assert.equal(isWithinWorkHours({ ...allDay, work_days: 1 << 1 }, utc(2026, 9, 4, 21, 30)), true);  // Mon locally
  assert.equal(isWithinWorkHours({ ...allDay, work_days: 1 << 0 }, utc(2026, 9, 4, 21, 30)), false); // not Sun locally
});

test("isWithinWorkHours is false while either time is missing or the window is empty", () => {
  const ts = utc(2026, 9, 5, 6, 0);
  assert.equal(isWithinWorkHours({ ...DUBAI, work_end: null }, ts), false);
  assert.equal(isWithinWorkHours({ ...DUBAI, work_start: null }, ts), false);
  assert.equal(isWithinWorkHours({ ...DUBAI, work_start: "17:00", work_end: "09:00" }, ts), false);
  assert.equal(isWithinWorkHours(null, ts), false);
});

test("isFreshEvent accepts up to 6 hours old and 5 minutes ahead", () => {
  const now = 1_800_000_000;
  assert.equal(isFreshEvent(now - 6 * 3600, now), true);
  assert.equal(isFreshEvent(now - 6 * 3600 - 1, now), false);
  assert.equal(isFreshEvent(now + 300, now), true);
  assert.equal(isFreshEvent(now + 301, now), false);
});

test("activeSeconds removes break time once, even when breaks overlap or are still open", () => {
  assert.equal(activeSeconds(0, 100), 100);
  assert.equal(activeSeconds(0, 100, [[10, 30], [20, 40]]), 70);  // union 10–40 = 30
  assert.equal(activeSeconds(0, 100, [[-50, 10], [90, null]]), 80); // clipped; open break runs to 100
  assert.equal(activeSeconds(100, 100, [[0, 200]]), 0);
});

test("lastActivityAt / idleSeconds take the latest of start, monitoring start and last event", () => {
  assert.equal(lastActivityAt({ startedAt: 100, monitoringSince: null, lastEventAt: null }), 100);
  assert.equal(lastActivityAt({ startedAt: 100, monitoringSince: 500, lastEventAt: 300 }), 500);
  assert.equal(idleSeconds({ startedAt: 0, lastEventAt: 1000, now: 4600 }), 3600);
  assert.equal(idleSeconds({ startedAt: 0, lastEventAt: 1000, now: 4600, breaks: [[2000, 2600]] }), 3000);
  assert.equal(idleSeconds({ startedAt: 0, monitoringSince: 4000, lastEventAt: 1000, now: 4600 }), 600);
});

test("sessionSummary counts the monitored part only, with breaks removed from gaps", () => {
  const s = sessionSummary({
    startedAt: 0, endedAt: 10_000, monitoringSince: 0,
    eventTimes: [3000, 1000, 20_000], // 20 000 is after the session: ignored
    breaks: [[5000, 6000]],
  });
  // points 0,1000,3000,10000 → gaps 1000, 2000, 7000 − 1000 (break) = 6000
  assert.deepEqual(s, { activity_count: 2, last_activity_at: 3000, longest_idle_sec: 6000 });
  assert.deepEqual(
    sessionSummary({ startedAt: 0, endedAt: 1000, monitoringSince: 400, eventTimes: [100] }),
    { activity_count: 0, last_activity_at: null, longest_idle_sec: 600 });
  assert.equal(sessionSummary({ startedAt: 0, endedAt: 1000, monitoringSince: null, eventTimes: [] }), null);
  assert.equal(sessionSummary({ startedAt: 0, endedAt: 1000, monitoringSince: 1000, eventTimes: [] }), null);
});
```

In `package.json`, add `src/activity.test.mjs` to the end of the `test:unit` file list:

```json
"test:unit": "node --test src/tz.test.mjs src/tokenCrypto.test.mjs src/ghlWebhook.test.mjs src/ghlOAuth.test.mjs src/activity.test.mjs"
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module …/src/activity.js`.

- [ ] **Step 3: Implement `src/activity.js`**

```js
/* Activity monitoring rules (spec §5.3, §5.6). Pure functions: no database, no clock. */
import { localDate, wallToUtc } from "./tz.js";

/** A not-clocked-in alert is opened only by an event at most this old … */
export const ALERT_MAX_AGE_SEC = 6 * 3600;
/** … and at most this far in the future (clock skew), so a replay or a late retry opens nothing. */
export const ALERT_MAX_SKEW_SEC = 5 * 60;
/** work_days bitmask with every weekday set (bit 0 = Sunday … bit 6 = Saturday). */
export const ALL_DAYS = 127;

/** Weekday (0 = Sunday … 6 = Saturday) of the local date holding `ts`. */
export function localWeekday(tz, ts) {
  const { y, m, d } = localDate(tz, ts);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * True when `ts` falls on a working day, at or after work_start and before work_end, in the
 * location's timezone (DST-aware). Either time missing → false: no not-clocked-in alerts
 * until the manager sets both.
 */
export function isWithinWorkHours(st, ts) {
  if (!st?.work_start || !st?.work_end || st.work_start >= st.work_end) return false;
  const tz = st.timezone || "Asia/Riyadh";
  const days = st.work_days == null ? ALL_DAYS : Number(st.work_days);
  if (!(days & (1 << localWeekday(tz, ts)))) return false;
  const day = localDate(tz, ts);
  return ts >= wallToUtc(tz, day, st.work_start) && ts < wallToUtc(tz, day, st.work_end);
}

/** True for an event recent enough to open an alert (see ALERT_MAX_AGE_SEC / _SKEW_SEC). */
export function isFreshEvent(occurredAt, now) {
  return occurredAt >= now - ALERT_MAX_AGE_SEC && occurredAt <= now + ALERT_MAX_SKEW_SEC;
}

/** Union of [start, end] intervals (end null = still running), clipped to [from, until]. */
function clipMerge(intervals, from, until) {
  const xs = intervals
    .map(([s, e]) => [Math.max(Number(s), from), Math.min(e == null ? until : Number(e), until)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Seconds of [from, until] not covered by any break (overlapping breaks count once). */
export function activeSeconds(from, until, breaks = []) {
  if (until <= from) return 0;
  const covered = clipMerge(breaks, from, until).reduce((sum, [s, e]) => sum + (e - s), 0);
  return until - from - covered;
}

/** The latest of the session start, the monitoring start and the last counted event. */
export function lastActivityAt({ startedAt, monitoringSince = null, lastEventAt = null }) {
  return Math.max(...[startedAt, monitoringSince, lastEventAt].filter((x) => x != null).map(Number));
}

/** Idle seconds of an open session at `now`: time since the last activity, breaks removed. */
export function idleSeconds({ startedAt, monitoringSince = null, lastEventAt = null, now, breaks = [] }) {
  return activeSeconds(lastActivityAt({ startedAt, monitoringSince, lastEventAt }), now, breaks);
}

/**
 * Activity summary of a closed session (spec §5.6), or null when monitoring never covered
 * it. Only the monitored part counts: from max(start, monitoringSince) to the end.
 * `eventTimes` are this employee's counted events (rows with a user id).
 */
export function sessionSummary({ startedAt, endedAt, monitoringSince, eventTimes = [], breaks = [] }) {
  const end = Number(endedAt);
  if (monitoringSince == null || Number(monitoringSince) >= end) return null;
  const from = Math.max(Number(startedAt), Number(monitoringSince));
  const events = eventTimes.map(Number).filter((x) => x >= from && x <= end).sort((a, b) => a - b);
  const points = [from, ...events, end];
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    longest = Math.max(longest, activeSeconds(points[i - 1], points[i], breaks));
  }
  return {
    activity_count: events.length,
    last_activity_at: events.length ? events[events.length - 1] : null,
    longest_idle_sec: longest,
  };
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npm run test:unit`
Expected: **49 pass, 0 fail** (40 + 9).

- [ ] **Step 5: Commit**

```bash
git add src/activity.js src/activity.test.mjs package.json
git commit -m "feat(activity): pure rules for working hours, freshness, idle time and session summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The not-clocked-in alert opens when an event arrives

**Files:**
- Modify: `src/server.js` (imports; webhook route ~L998-1062; `/session/start` ~L444; new `GET /admin/alerts` after `/admin/ghl-connection`), `scripts/smoke-test.mjs`, `PROJECT.md` §8

**Interfaces:**
- Consumes: `isWithinWorkHours`, `isFreshEvent` (Task 2); `settings.work_end`, `settings.work_days` (Task 1).
- Produces:
  - `GET /admin/alerts?status=open|resolved|dismissed` → `{ alerts: [{ id, user_id, name, kind, from_at, to_at, status, resolution, employee_note, employee_note_at, detected_at }], timezone, server_time }` (numbers for every timestamp; newest `from_at` first; max 200).
  - Alert rows: `kind = 'working_not_clocked_in'`, `session_id = NULL`, `status = 'open'` until resolved (`clocked_in` by `system`) or dismissed.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, immediately before the line `const awBig = await ghlWebhook(` (still inside nothing — that line is after the `if (!awAcceptsTestKey) … else { … }` block), add:

```js
// --- Not-clocked-in alert (activity phase B, spec §5.3). Own location, UTC, needs the test key.
const NCLOC = `${LOC}-nc`;
const ncMgr = await sso({ userId: `${NCLOC}-m1`, role: "admin", type: "account", activeLocation: NCLOC, userName: "مدير التنبيهات", email: "ncm@x.com" });
const ncE1 = await sso({ userId: `${NCLOC}-u1`, role: "user", type: "account", activeLocation: NCLOC, userName: "موظف أول", email: "nc1@x.com" });
const ncE2 = await sso({ userId: `${NCLOC}-u2`, role: "user", type: "account", activeLocation: NCLOC, userName: "موظف تاني", email: "nc2@x.com" });
const NCM = ncMgr.body?.token, NC1 = ncE1.body?.token, NC2 = ncE2.body?.token;
const ncNow = Math.floor(Date.now() / 1000);
const ncTod = ncNow % 86400;
let ncSeq = 0;
const ncEvent = (userId, at = Math.floor(Date.now() / 1000)) => {
  ncSeq++;
  const p = { type: "OutboundMessage", locationId: NCLOC, messageType: "SMS", source: "app",
    dateAdded: new Date(at * 1000).toISOString(), webhookId: `${NCLOC}-w${ncSeq}`, messageId: `${NCLOC}-m${ncSeq}` };
  if (userId) p.userId = userId;
  return ghlWebhook(p);
};
const ncOpen = async () => (await call(NCM, "GET", "/admin/alerts?status=open")).body?.alerts ?? [];
const ncOpenFor = async (uid) => (await ncOpen()).filter((a) => a.user_id === uid);
const ncHours = (extra) => call(NCM, "PUT", "/admin/settings",
  { timezone: "UTC", work_start: "00:00", work_end: "23:59", work_days: 127, activity_monitoring: true, ...extra });

if (!awAcceptsTestKey) {
  console.log("  SKIP  not-clocked-in alert checks (target refuses the test signing key)");
} else if (ncTod < 120 || ncTod > 86400 - 180) {
  console.log("  SKIP  not-clocked-in alert checks (too close to UTC midnight)");
} else {
  await ncHours({});
  check("an employee's event inside working hours opens one not-clocked-in alert",
    (await ncEvent(`${NCLOC}-u1`)).status === 200 && (await ncOpenFor(`${NCLOC}-u1`)).length === 1);
  const ncA = (await ncOpenFor(`${NCLOC}-u1`))[0];
  check("the alert carries the kind, the employee's name and the event time",
    ncA?.kind === "working_not_clocked_in" && ncA?.name === "موظف أول" && Math.abs(Number(ncA?.from_at) - ncNow) <= 10,
    `(${JSON.stringify(ncA)})`);
  await ncEvent(`${NCLOC}-u1`);
  check("a second event keeps a single open alert", (await ncOpenFor(`${NCLOC}-u1`)).length === 1);

  await ncEvent(null);
  check("an event without a user id opens nothing", (await ncOpen()).length === 1);
  await ncEvent(`${NCLOC}-m1`);
  check("a manager's event opens nothing", (await ncOpenFor(`${NCLOC}-m1`)).length === 0);
  await ncEvent(`${NCLOC}-stranger`);
  check("a user who never opened TimeClock opens nothing", (await ncOpenFor(`${NCLOC}-stranger`)).length === 0);
  await ncEvent(`${NCLOC}-u2`, ncNow - 7 * 3600);
  check("an event older than 6 hours opens nothing", (await ncOpenFor(`${NCLOC}-u2`)).length === 0);

  await call(NC2, "POST", "/session/start");
  await ncEvent(`${NCLOC}-u2`);
  check("an employee with an open session gets no alert", (await ncOpenFor(`${NCLOC}-u2`)).length === 0);
  await call(NC2, "POST", "/session/stop");
  const ncS2 = (await call(NCM, "GET", `/admin/sessions?from=${ncNow - 86400}&to=${ncNow + 60}&user_id=${NCLOC}-u2`)).body?.sessions?.[0];
  const ncPinned = ncS2 && (await call(NCM, "PATCH", `/admin/sessions/${ncS2.id}`,
    { started_at: ncNow - 3600, ended_at: ncNow - 1800, reason: "تثبيت وقت للاختبار" })).status === 200;
  await ncEvent(`${NCLOC}-u2`, ncNow - 2700);
  check("an event inside a session that covers its time opens nothing",
    ncPinned && (await ncOpenFor(`${NCLOC}-u2`)).length === 0, `(pinned ${ncPinned})`);

  // A one-hour window twelve hours away from now cannot contain now.
  const ncFarH = String((Math.floor(ncTod / 3600) + 12) % 24).padStart(2, "0");
  await ncHours({ work_start: `${ncFarH}:00`, work_end: `${ncFarH}:59` });
  await ncEvent(`${NCLOC}-u2`);
  check("an event outside working hours opens nothing", (await ncOpenFor(`${NCLOC}-u2`)).length === 0);
  await ncHours({ work_days: 127 & ~(1 << new Date().getUTCDay()) });
  await ncEvent(`${NCLOC}-u2`);
  check("an event on a day off opens nothing", (await ncOpenFor(`${NCLOC}-u2`)).length === 0);
  await ncHours({ work_end: null });
  await ncEvent(`${NCLOC}-u2`);
  check("without a work_end nothing opens", (await ncOpenFor(`${NCLOC}-u2`)).length === 0);
  await ncHours({});
  await ncEvent(`${NCLOC}-u2`);
  check("the same employee inside working hours does get an alert (the checks above are not vacuous)",
    (await ncOpenFor(`${NCLOC}-u2`)).length === 1);

  check("an employee cannot list alerts", (await call(NC1, "GET", "/admin/alerts")).status === 403);
  check("an unknown status → 400", (await call(NCM, "GET", "/admin/alerts?status=maybe")).body?.error === "INVALID_STATUS");
  const ncList = await call(NCM, "GET", "/admin/alerts");
  check("the alert list reports the location timezone and server time",
    ncList.body?.timezone === "UTC" && Number.isInteger(ncList.body?.server_time));

  await call(NC1, "POST", "/session/start");
  check("clocking in resolves the employee's alert", (await ncOpenFor(`${NCLOC}-u1`)).length === 0);
  const ncResolved = ((await call(NCM, "GET", "/admin/alerts?status=resolved")).body?.alerts ?? [])
    .find((a) => a.user_id === `${NCLOC}-u1`);
  check("the resolved alert says it was resolved by clocking in",
    ncResolved?.status === "resolved" && ncResolved?.resolution === "clocked_in", `(${JSON.stringify(ncResolved)})`);
  await call(NC1, "POST", "/session/stop");
}
await cleanupLocation(NCLOC);
```

- [ ] **Step 2: Run the smoke test to see it fail**

Restart the API, run the smoke test. Expected: the first new check FAILs (`/admin/alerts` is the SPA fallback / no alert opened); phase A checks still PASS.

- [ ] **Step 3: Open the alert in the webhook route**

In `src/server.js`:

1. Add to the imports:

```js
import { isWithinWorkHours, isFreshEvent } from "./activity.js";
```

2. Just below `const now = () => …`, add:

```js
// Trimmed: a stray space pasted into hPanel would otherwise reject every install event.
const GHL_APP_ID = (env.GHL_APP_ID ?? "").trim() || null;
const numOrNull = (v) => (v == null ? null : Number(v));
```

3. Just above `app.post("/webhooks/events", …)`, next to `let lastBadSignatureLogAt = 0;`, add:

```js
// Logged once per process: an install event for another app is normal (GHL signs every
// app's events with one key), but a first mismatch is worth seeing in case GHL_APP_ID is wrong.
let loggedForeignAppId = false;

/**
 * Opens a "working, not clocked in" alert for one stored event when every rule of spec §5.3
 * holds: fresh event, inside working hours, an employee (not a manager) we know, and no
 * session open or covering the event. ux_alert_nci_open keeps one open alert per employee,
 * so a burst of events — or two concurrent deliveries — opens exactly one (INSERT IGNORE).
 */
async function openNotClockedInAlert(st, loc, uid, at, t) {
  if (!isFreshEvent(at, t) || !isWithinWorkHours(st, at)) return;
  const [emp] = await q(
    `SELECT 1 AS ok FROM employees
      WHERE location_id = :loc AND user_id = :uid AND role = 'employee' AND is_active = 1`,
    { loc, uid }
  );
  if (!emp) return;
  const [busy] = await q(
    `SELECT 1 AS ok FROM sessions
      WHERE location_id = :loc AND user_id = :uid
        AND (ended_at IS NULL OR (started_at <= :at AND ended_at > :at))
      LIMIT 1`,
    { loc, uid, at }
  );
  if (busy) return;
  await q(
    `INSERT IGNORE INTO activity_alerts (id, location_id, user_id, session_id, kind, from_at, detected_at, status)
     VALUES (:id, :loc, :uid, NULL, 'working_not_clocked_in', :at, :t, 'open')`,
    { id: randomUUID(), loc, uid, at, t }
  );
}
```

4. In the webhook route, replace

```js
    if (!isForOurApp(ev, env.GHL_APP_ID)) return c.json({ ok: true });
```

with

```js
    if (!isForOurApp(ev, GHL_APP_ID)) {
      if (!loggedForeignAppId) {
        loggedForeignAppId = true;
        console.warn("[webhook] install/uninstall for another app ignored", { appId: ev.appId ?? null });
      }
      return c.json({ ok: true });
    }
```

5. Replace the whole `if (ev.event === "activity") { … }` block with:

```js
  if (ev.event === "activity") {
    const st = await getSettings(ev.locationId);
    if (st?.activity_monitoring) {
      // GHL retries a failed delivery up to 12 times, and the same message can arrive again
      // through another app with a new webhookId: the key prefers the message id.
      const webhookId = activityDedupeKey(ev, raw);
      await q(
        `INSERT IGNORE INTO activity_events
           (id, location_id, user_id, occurred_at, kind, message_type, source, webhook_id, created_at)
         VALUES (:id, :loc, :uid, :at, :kind, :messageType, :source, :webhookId, :t)`,
        {
          id: randomUUID(), loc: ev.locationId, uid: ev.userId, at: ev.occurredAt, kind: ev.kind,
          messageType: ev.messageType == null ? null : String(ev.messageType).slice(0, 40),
          source: ev.source == null ? null : String(ev.source).slice(0, 60),
          webhookId, t,
        }
      );
      // Only an event with a user id is a person's activity (spec §2.1).
      if (ev.userId) await openNotClockedInAlert(st, ev.locationId, String(ev.userId), ev.occurredAt, t);
    }
  }
```

- [ ] **Step 4: Resolve on clock-in**

In `app.post("/session/start", …)`, after the `try { await q("INSERT INTO sessions …") } catch …` block and before `return c.json({ id, started_at: t }, 201);`, add:

```js
  // Clocking in answers any open "working, not clocked in" alert (spec §5.3).
  await q(
    `UPDATE activity_alerts
        SET status = 'resolved', resolution = 'clocked_in', resolved_by = 'system', resolved_at = :t
      WHERE location_id = :loc AND user_id = :uid AND kind = 'working_not_clocked_in' AND status = 'open'`,
    { loc, uid, t }
  );
```

- [ ] **Step 5: Add `GET /admin/alerts`**

After the `app.get("/admin/ghl-connection", …)` route, add:

```js
const ALERT_STATUSES = ["open", "resolved", "dismissed"];
const ALERT_COLUMNS = `a.id, a.user_id, a.kind, a.from_at, a.to_at, a.status, a.resolution,
  a.employee_note, a.employee_note_at, a.detected_at`;
/** BIGINT columns as plain numbers, so the UI never sees a string timestamp. */
function alertRow(r) {
  return {
    ...r,
    from_at: Number(r.from_at), to_at: numOrNull(r.to_at), detected_at: Number(r.detected_at),
    employee_note_at: numOrNull(r.employee_note_at),
  };
}

app.get("/admin/alerts", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const status = c.req.query("status") ?? "open";
  if (!ALERT_STATUSES.includes(status)) throw new HttpError(400, "INVALID_STATUS");
  const alerts = (await q(
    `SELECT ${ALERT_COLUMNS}, e.name
       FROM activity_alerts a
       LEFT JOIN employees e ON e.user_id = a.user_id AND e.location_id = a.location_id
      WHERE a.location_id = :loc AND a.status = :status
      ORDER BY a.from_at DESC
      LIMIT 200`,
    { loc, status }
  )).map(alertRow);
  const st = await getSettings(loc);
  return c.json({ alerts, timezone: st?.timezone ?? "Asia/Riyadh", server_time: now() });
});
```

- [ ] **Step 6: Run the smoke test**

Restart the API, run the smoke test. Expected: **0 failed**; Task 1's 128 + 18 new = **146 passed** (if the run is within 3 minutes of UTC midnight the block prints SKIP — run again later).

- [ ] **Step 7: Document**

`PROJECT.md` §8: in the "المدير" table add

```markdown
| GET | `/admin/alerts?status=` | تنبيهات النشاط: `status` = `open` (افتراضي) أو `resolved` أو `dismissed` → `{ alerts: [{ id, user_id, name, kind, from_at, to_at, status, resolution, employee_note, employee_note_at, detected_at }], timezone, server_time }` (الأحدث أول، حد أقصى 200) · `400 INVALID_STATUS` |
```

In the `/webhooks/events` row add: "إذا الحدث فيه `userId` لموظف (`role = employee`) فتح TimeClock قبل، وصار جوّا ساعات الدوام (`work_start`…`work_end`، أيام `work_days`، بتوقيت الحساب)، وعمره أقل من 6 ساعات، وما عنده جلسة مفتوحة أو مغطّية لوقته → بينفتح تنبيه `working_not_clocked_in` (واحد مفتوح بالكثير لكل موظف)". In the `/session/start` row add: "بيسكّر تنبيه «عم يشتغل بدون دوام» المفتوح (`resolution = clocked_in`)". Error table:

```markdown
| `INVALID_STATUS` | 400 | `status` مش `open`/`resolved`/`dismissed` | — |
```

- [ ] **Step 8: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(activity): alert when an employee works in GHL during working hours without clocking in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dismiss, the employee's alerts and the employee's note

**Files:**
- Modify: `src/server.js` (after `GET /admin/alerts`; employee routes after `/me/sessions`), `scripts/smoke-test.mjs`, `PROJECT.md` §8

**Interfaces:**
- Consumes: `ALERT_COLUMNS`, `alertRow` (Task 3).
- Produces:
  - `POST /admin/alerts/:id/dismiss` → `{ ok: true }` · `404 ALERT_NOT_FOUND` (not open, or another location).
  - `GET /me/alerts` → `{ alerts: [same shape as /admin/alerts, without name], timezone, server_time }` (caller's open alerts).
  - `POST /me/alerts/:id/note` body `{ note }` → `{ ok: true }` · `400 NOTE_REQUIRED` · `400 NOTE_TOO_LONG` (> 300) · `404 ALERT_NOT_FOUND`.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, inside the Task 3 block, replace the last two lines of the `else { … }` branch

```js
  await call(NC1, "POST", "/session/start");
  check("clocking in resolves the employee's alert", (await ncOpenFor(`${NCLOC}-u1`)).length === 0);
```

with the same two lines preceded by these checks (they use u2's open alert and u1's open alert, both open at that point):

```js
  const ncMine = await call(NC2, "GET", "/me/alerts");
  const ncA2 = ncMine.body?.alerts?.[0];
  check("an employee sees their own open alert",
    ncMine.status === 200 && ncMine.body?.alerts?.length === 1 && ncA2?.user_id === `${NCLOC}-u2`
      && ncMine.body?.timezone === "UTC",
    `(${JSON.stringify(ncMine.body)})`);
  check("an empty note → 400", (await call(NC2, "POST", `/me/alerts/${ncA2?.id}/note`, { note: "  " })).body?.error === "NOTE_REQUIRED");
  check("a note over 300 characters → 400",
    (await call(NC2, "POST", `/me/alerts/${ncA2?.id}/note`, { note: "x".repeat(301) })).body?.error === "NOTE_TOO_LONG");
  check("an employee cannot note someone else's alert",
    (await call(NC1, "POST", `/me/alerts/${ncA2?.id}/note`, { note: "مش إلي" })).body?.error === "ALERT_NOT_FOUND");
  check("the employee's note is saved",
    (await call(NC2, "POST", `/me/alerts/${ncA2?.id}/note`, { note: "كنت عم رد على زبون من الموبايل" })).status === 200);
  check("the manager sees the employee's note",
    (await ncOpenFor(`${NCLOC}-u2`))[0]?.employee_note === "كنت عم رد على زبون من الموبايل");
  check("an employee cannot dismiss", (await call(NC2, "POST", `/admin/alerts/${ncA2?.id}/dismiss`)).status === 403);
  const ncOther = await sso({ userId: `${NCLOC}-x-m1`, role: "admin", type: "account", activeLocation: `${NCLOC}-x`, userName: "مدير غريب", email: "ncx@x.com" });
  check("another location's manager cannot dismiss it",
    (await call(ncOther.body?.token, "POST", `/admin/alerts/${ncA2?.id}/dismiss`)).body?.error === "ALERT_NOT_FOUND");
  check("the manager dismisses it", (await call(NCM, "POST", `/admin/alerts/${ncA2?.id}/dismiss`)).status === 200);
  check("a dismissed alert leaves the open list and the employee's list",
    (await ncOpenFor(`${NCLOC}-u2`)).length === 0 && (await call(NC2, "GET", "/me/alerts")).body?.alerts?.length === 0);
  check("dismissing it again → 404", (await call(NCM, "POST", `/admin/alerts/${ncA2?.id}/dismiss`)).body?.error === "ALERT_NOT_FOUND");
  check("a note on a dismissed alert → 404",
    (await call(NC2, "POST", `/me/alerts/${ncA2?.id}/note`, { note: "متأخر" })).body?.error === "ALERT_NOT_FOUND");
  await cleanupLocation(`${NCLOC}-x`);
```

- [ ] **Step 2: Run to see it fail**

Restart the API, run the smoke test. Expected: "an employee sees their own open alert" FAILs (route missing).

- [ ] **Step 3: Implement the routes**

In `src/server.js`, after `GET /admin/alerts`, add:

```js
app.post("/admin/alerts/:id/dismiss", authed, managerOnly, async (c) => {
  const { loc, uid } = c.get("claims");
  const r = await q(
    `UPDATE activity_alerts
        SET status = 'dismissed', resolution = 'dismissed', resolved_by = :uid, resolved_at = :t
      WHERE id = :id AND location_id = :loc AND status = 'open'`,
    { id: c.req.param("id"), loc, uid, t: now() }
  );
  if (!r.affectedRows) throw new HttpError(404, "ALERT_NOT_FOUND");
  return c.json({ ok: true });
});
```

After `app.get("/me/sessions", …)`, add:

```js
const ALERT_NOTE_MAX = 300;

app.get("/me/alerts", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  const alerts = (await q(
    `SELECT ${ALERT_COLUMNS} FROM activity_alerts a
      WHERE a.location_id = :loc AND a.user_id = :uid AND a.status = 'open'
      ORDER BY a.from_at DESC`,
    { loc, uid }
  )).map(alertRow);
  const st = await getSettings(loc);
  return c.json({ alerts, timezone: st?.timezone ?? "Asia/Riyadh", server_time: now() });
});

app.post("/me/alerts/:id/note", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  const body = (await c.req.json().catch(() => null)) ?? {};
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) throw new HttpError(400, "NOTE_REQUIRED");
  if (note.length > ALERT_NOTE_MAX) throw new HttpError(400, "NOTE_TOO_LONG");
  const r = await q(
    `UPDATE activity_alerts SET employee_note = :note, employee_note_at = :t
      WHERE id = :id AND location_id = :loc AND user_id = :uid AND status = 'open'`,
    { note, t: now(), id: c.req.param("id"), loc, uid }
  );
  if (!r.affectedRows) throw new HttpError(404, "ALERT_NOT_FOUND");
  return c.json({ ok: true });
});
```

`ALERT_COLUMNS` and `alertRow` are defined in Task 3 above `GET /admin/alerts`; the `/me/alerts` routes sit earlier in the file, which is fine because they only run after the module has finished loading.

- [ ] **Step 4: Run the smoke test**

Restart the API, run it. Expected: **0 failed**, Task 3's 146 + 12 new = **158 passed**.

- [ ] **Step 5: Document**

`PROJECT.md` §8 — "الموظف" table:

```markdown
| GET | `/me/alerts` | تنبيهاتي المفتوحة → `{ alerts, timezone, server_time }` |
| POST | `/me/alerts/:id/note` | Body: `{ note }` (حد أقصى 300 حرف) — ملاحظة الموظف على تنبيهه المفتوح · `400 NOTE_REQUIRED` · `400 NOTE_TOO_LONG` · `404 ALERT_NOT_FOUND` |
```

"المدير" table:

```markdown
| POST | `/admin/alerts/:id/dismiss` | تجاهل تنبيه مفتوح → `{ ok: true }` · `404 ALERT_NOT_FOUND` |
```

Error table: add `| \`ALERT_NOT_FOUND\` | 404 | التنبيه مش موجود، أو مش مفتوح، أو مش إلك | التنبيه ما عاد موجود |`, and in the `NOTE_TOO_LONG` row change "أكتر من 500 حرف" to "أكتر من 500 حرف (ملاحظة الإنهاء) أو 300 (ملاحظة التنبيه)".

- [ ] **Step 6: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(activity): managers dismiss alerts; employees see theirs and answer with a note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Idle time, session summaries and the connection extras

**Files:**
- Modify: `src/server.js` (imports; new `summarizeClosedSessions` + `liveActivity` near `autoCloseStale`; `autoCloseStale`; `/session/stop`; `PATCH /admin/sessions/:id`; `/admin/live`; `/admin/sessions`; `/admin/export.csv`; `/admin/ghl-connection`; `/me/status`; boot timers), `scripts/smoke-test.mjs`, `PROJECT.md` §8

**Interfaces:**
- Consumes: `lastActivityAt`, `idleSeconds`, `sessionSummary` (Task 2); `fixedWindows` from `src/tz.js`; `todayFixedBreak` (existing).
- Produces:
  - `GET /admin/live` → adds top-level `idle_minutes` (number | null) and per employee `last_activity_at` (number | null), `idle_sec` (number | null), `active_without_session` (boolean).
  - `GET /admin/sessions` → each session adds `activity_count`, `longest_idle_sec` (number | null).
  - CSV adds columns `Activity` and `Longest idle (min)`.
  - `GET /admin/ghl-connection` → adds `unknown_active_users` (number).
  - `GET /me/status` → adds `activity_monitoring` (boolean).

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, directly after `await cleanupLocation(NCLOC);` (Task 3), add:

```js
// --- Idle information and session summary (activity phase B, spec §5.3 / §5.6). Local DB only:
// --- sessions and the monitoring start are backdated directly.
const IDLOC = `${LOC}-id`;
const idMgr = await sso({ userId: `${IDLOC}-m1`, role: "admin", type: "account", activeLocation: IDLOC, userName: "مدير الخمول", email: "idm@x.com" });
const idEmp = await sso({ userId: `${IDLOC}-u1`, role: "user", type: "account", activeLocation: IDLOC, userName: "موظف الخمول", email: "ide@x.com" });
const IDM = idMgr.body?.token, IDE = idEmp.body?.token;
let idSeq = 0;
const idEvent = (userId) => {
  idSeq++;
  return ghlWebhook({ type: "OutboundMessage", locationId: IDLOC, userId, messageType: "SMS", source: "app",
    dateAdded: new Date().toISOString(), webhookId: `${IDLOC}-w${idSeq}`, messageId: `${IDLOC}-m${idSeq}` });
};
const idLive = async () => (await call(IDM, "GET", "/admin/live")).body;
const idMe = async () => (await idLive())?.employees?.find((e) => e.user_id === `${IDLOC}-u1`);

await call(IDM, "PUT", "/admin/settings", { timezone: "UTC", activity_monitoring: true, idle_minutes: 10 });
check("the employee status says whether monitoring is on",
  (await call(IDE, "GET", "/me/status")).body?.activity_monitoring === true);
check("live reports the idle threshold", (await idLive())?.idle_minutes === 10);

const idT = Math.floor(Date.now() / 1000);
const idBack = await withLocalDb((conn) =>
  conn.execute("UPDATE settings SET activity_monitoring_since = ? WHERE location_id = ?", [idT - 7200, IDLOC]));
if (!awAcceptsTestKey || idBack.skipped) {
  console.log(`  SKIP  idle and summary checks (${idBack.skipped ?? "target refuses the test signing key"})`);
} else {
  await call(IDE, "POST", "/session/start");
  await localRows("UPDATE sessions SET started_at = :s WHERE location_id = :loc AND ended_at IS NULL", { s: idT - 3600, loc: IDLOC });
  check("no idle time is shown before any event has arrived (outage guard)", (await idMe())?.idle_sec === null);

  await idEvent(`${IDLOC}-stranger`); // someone who never opened TimeClock: proves events arrive
  const idIdle = await idMe();
  check("an open session with no activity for an hour shows about an hour idle",
    Math.abs(Number(idIdle?.idle_sec) - 3600) <= 10 && idIdle?.last_activity_at === null, `(${JSON.stringify(idIdle)})`);
  check("unknown active users are counted for the connection status",
    (await call(IDM, "GET", "/admin/ghl-connection")).body?.unknown_active_users === 1);

  await idEvent(`${IDLOC}-u1`);
  const idActive = await idMe();
  check("an event resets the idle time",
    Number(idActive?.idle_sec) <= 10 && Math.abs(Number(idActive?.last_activity_at) - idT) <= 10, `(${JSON.stringify(idActive)})`);

  await call(IDE, "POST", "/session/stop");
  const idS = (await call(IDM, "GET", `/admin/sessions?from=${idT - 86400}&to=${idT + 60}&user_id=${IDLOC}-u1`)).body?.sessions?.[0];
  check("stopping stores the session's activity summary",
    idS?.activity_count === 1 && Math.abs(Number(idS?.longest_idle_sec) - 3600) <= 10, `(${JSON.stringify(idS)})`);
  const idCsv = await call(IDM, "GET", `/admin/export.csv?from=${idT - 86400}&to=${idT + 60}`);
  check("the CSV has the activity columns", String(idCsv.body).includes("Longest idle (min)"));

  const idEdit = await call(IDM, "PATCH", `/admin/sessions/${idS?.id}`,
    { started_at: idT - 600, ended_at: idT + 0, reason: "تقصير للاختبار" });
  const idS2 = (await call(IDM, "GET", `/admin/sessions?from=${idT - 86400}&to=${idT + 60}&user_id=${IDLOC}-u1`)).body?.sessions?.[0];
  check("a manager edit recomputes the summary",
    idEdit.status === 200 && Number(idS2?.longest_idle_sec) <= 600, `(${JSON.stringify(idS2)})`);

  await localRows("DELETE FROM activity_events WHERE location_id = :loc", { loc: IDLOC });
  await call(IDE, "POST", "/session/start");
  check("with no event in 24 hours idle is not shown", (await idMe())?.idle_sec === null);
  await call(IDE, "POST", "/session/stop");

  await call(IDM, "PUT", "/admin/settings", { activity_monitoring: false });
  check("with monitoring off live has no idle threshold", (await idLive())?.idle_minutes === null);
}
await cleanupLocation(IDLOC);
```

- [ ] **Step 2: Run to see it fail**

Restart the API, run the smoke test. Expected: "the employee status says whether monitoring is on" FAILs (field missing).

- [ ] **Step 3: Summaries — one function every close path reaches**

In `src/server.js`:

1. Extend the imports:

```js
import { localZone, localDate, wallToUtc, fixedWindows, localDayBounds } from "./tz.js";
import { isWithinWorkHours, isFreshEvent, lastActivityAt, idleSeconds, sessionSummary } from "./activity.js";
```

2. Just after the `autoCloseStale` function, add:

```js
/** Break intervals of one session as [start, end|null], plus its fixed windows (paid ones too). */
async function sessionBreaks(session, st, until) {
  const rows = await q("SELECT started_at, ended_at FROM breaks WHERE session_id = :sid", { sid: session.id });
  const out = rows.map((b) => [Number(b.started_at), b.ended_at == null ? null : Number(b.ended_at)]);
  if (st?.break_mode === "fixed" && st.break_start && st.break_end) {
    out.push(...fixedWindows(st.timezone, Number(session.started_at), until, st.break_start, st.break_end));
  }
  return out;
}

/** This employee's counted events (with a user id) inside [from, to]. */
async function eventTimes(loc, uid, from, to) {
  const rows = await q(
    `SELECT occurred_at FROM activity_events
      WHERE location_id = :loc AND user_id = :uid AND occurred_at >= :from AND occurred_at <= :to`,
    { loc, uid, from, to }
  );
  return rows.map((r) => Number(r.occurred_at));
}

/**
 * Stores the activity summary (spec §5.6) of recently closed sessions that have none, for
 * locations with monitoring on. Every close path ends up here — /session/stop, auto-close,
 * and a manager edit (which clears the summary first) — so the rule lives in one place.
 * A session that closed while monitoring was off keeps NULL, shown as "—".
 */
async function summarizeClosedSessions(loc = null) {
  const locs = loc
    ? [loc]
    : (await q("SELECT location_id FROM settings WHERE activity_monitoring = 1")).map((r) => r.location_id);
  const t = now();
  for (const l of locs) {
    const st = await getSettings(l);
    if (!st?.activity_monitoring || st.activity_monitoring_since == null) continue;
    const since = Number(st.activity_monitoring_since);
    const rows = await q(
      `SELECT id, user_id, started_at, ended_at FROM sessions
        WHERE location_id = :loc AND ended_at IS NOT NULL AND activity_count IS NULL
          AND ended_at > :since AND ended_at > :recent
        LIMIT 50`,
      { loc: l, since, recent: t - 7 * 86400 }
    );
    for (const s of rows) {
      const start = Number(s.started_at), end = Number(s.ended_at);
      const sum = sessionSummary({
        startedAt: start, endedAt: end, monitoringSince: since,
        eventTimes: await eventTimes(l, s.user_id, start, end),
        breaks: await sessionBreaks(s, st, end),
      });
      if (!sum) continue;
      await q(
        `UPDATE sessions SET activity_count = :n, last_activity_at = :last, longest_idle_sec = :idle
          WHERE id = :id AND activity_count IS NULL`,
        { n: sum.activity_count, last: sum.last_activity_at, idle: sum.longest_idle_sec, id: s.id }
      );
    }
  }
}
```

3. At the very end of `autoCloseStale` (after the `UPDATE breaks …` statement), add:

```js
  await summarizeClosedSessions(loc);
```

4. In `/session/stop`, after `await conn.commit();` and before `return c.json({…})`, add:

```js
    await summarizeClosedSessions(loc);
```

5. In `PATCH /admin/sessions/:id`, change the session `UPDATE` so the summary is recomputed:

```js
    await conn.execute(
      `UPDATE sessions SET started_at = :s, ended_at = :e, duration_sec = :dur, closed_by = 'admin',
                           activity_count = NULL, last_activity_at = NULL, longest_idle_sec = NULL
        WHERE id = :id AND location_id = :loc`,
      { s, e, dur: e - s, id, loc }
    );
```

and after `await conn.commit();` add `await summarizeClosedSessions(loc);`.

- [ ] **Step 4: Idle on the live floor**

Just after `summarizeClosedSessions`, add:

```js
/**
 * Per-employee activity for the live floor (spec §5.3): idle seconds of open sessions, and
 * who is working without a session. Idle is null when monitoring is off or when the
 * location's newest event is over 24 h old (outage guard — other apps' events also refresh
 * ghl_installs.last_event_at, so that column is not used here).
 */
async function liveActivity(loc, st, employees, t) {
  const blank = () => ({ last_activity_at: null, idle_sec: null, active_without_session: false });
  const out = new Map(employees.map((e) => [e.user_id, blank()]));
  if (!st?.activity_monitoring) return out;
  const nci = await q(
    `SELECT user_id FROM activity_alerts
      WHERE location_id = :loc AND kind = 'working_not_clocked_in' AND status = 'open'`,
    { loc }
  );
  for (const r of nci) if (out.has(r.user_id)) out.get(r.user_id).active_without_session = true;
  const [fresh] = await q("SELECT MAX(occurred_at) AS at FROM activity_events WHERE location_id = :loc", { loc });
  if (fresh?.at == null || Number(fresh.at) <= t - 86400) return out;
  for (const e of employees) {
    if (!e.session_id) continue;
    const start = Number(e.started_at);
    const times = await eventTimes(loc, e.user_id, start, t);
    const lastEventAt = times.length ? Math.max(...times) : null;
    const row = out.get(e.user_id);
    row.last_activity_at = lastEventAt;
    row.idle_sec = idleSeconds({
      startedAt: start, monitoringSince: st.activity_monitoring_since, lastEventAt, now: t,
      breaks: await sessionBreaks({ id: e.session_id, started_at: start }, st, t),
    });
  }
  return out;
}
```

Then replace the end of `app.get("/admin/live", …)`:

```js
  const t = now();
  return c.json({ server_time: t, fixed_break: todayFixedBreak(await getSettings(loc), t), employees });
```

with:

```js
  const t = now();
  const st = await getSettings(loc);
  const activity = await liveActivity(loc, st, employees, t);
  return c.json({
    server_time: t,
    fixed_break: todayFixedBreak(st, t),
    idle_minutes: st?.activity_monitoring ? Number(st.idle_minutes) : null,
    employees: employees.map((e) => ({ ...e, ...activity.get(e.user_id) })),
  });
```

- [ ] **Step 5: Sessions, CSV, connection and status fields**

1. `/admin/sessions`: in its `SELECT`, after `s.note,` add `s.activity_count, s.longest_idle_sec,`; and in the `.map(...)` after the query, also convert them:

```js
  )).map((r) => ({
    ...r,
    break_sec: Number(r.break_sec),
    activity_count: numOrNull(r.activity_count),
    longest_idle_sec: numOrNull(r.longest_idle_sec),
  }));
```

(`numOrNull` is the helper Task 3 defined below `const now = () => …`.)

2. `/admin/export.csv`: add `s.activity_count, s.longest_idle_sec,` to its `SELECT` (after `s.note,`), and change the header and row to:

```js
    ["Employee", "Email", "Start", "End", "Hours", "Break (min)", "Closed by", "Note", "Activity", "Longest idle (min)"],
    ...rows.map((r) => [r.name, r.email, fmt(r.started_at), fmt(r.ended_at),
      r.duration_sec ? (Math.max(0, Number(r.duration_sec) - Number(r.break_sec)) / 3600).toFixed(2) : "",
      breakMin(r.break_sec), r.closed_by ?? "open", r.note ?? "",
      r.activity_count ?? "", r.longest_idle_sec == null ? "" : Math.round(Number(r.longest_idle_sec) / 60)]),
```

3. `/admin/ghl-connection`: before `const scopes = …`, add

```js
  // Counted events (with a user id) from people who never opened TimeClock here (spec §5.4).
  const [unknown] = await q(
    `SELECT COUNT(DISTINCT a.user_id) AS n
       FROM activity_events a
       LEFT JOIN employees e ON e.user_id = a.user_id AND e.location_id = a.location_id
      WHERE a.location_id = :loc AND a.user_id IS NOT NULL AND a.occurred_at >= :since AND e.user_id IS NULL`,
    { loc, since: now() - 7 * 86400 }
  );
```

and add `unknown_active_users: Number(unknown.n),` to the returned object.

4. `/me/status`: add `activity_monitoring: Boolean(st?.activity_monitoring),` to the returned object (next to `day_ends_at`).

5. Boot: the 15-minute `autoCloseStale()` timer now also summarises (it calls `summarizeClosedSessions(null)`), so no new timer is needed.

- [ ] **Step 6: Run everything**

Restart the API; run the smoke test, `npm run test:unit`. Expected: smoke **0 failed**, Task 4's 158 + 11 new = **169 passed**; unit **49**.

- [ ] **Step 7: Document**

`PROJECT.md` §8: `/admin/live` row — add "`idle_minutes` (null إذا المراقبة مطفية)، ومع كل موظف `last_activity_at` و`idle_sec` (ثواني بلا نشاط بالجلسة المفتوحة بدون الاستراحات؛ `null` إذا المراقبة مطفية أو ما وصل ولا حدث بآخر 24 ساعة) و`active_without_session`". `/admin/sessions` row — add "`activity_count` و`longest_idle_sec` (`null` = ما كانت مراقبة)". CSV row — add the two columns. `/admin/ghl-connection` row — add `unknown_active_users` (مستخدمين إلهم نشاط بآخر 7 أيام وما فتحوا TimeClock). `/me/status` row — add `activity_monitoring`.

- [ ] **Step 8: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(activity): idle time on the live floor, per-session activity summary, unknown-users count

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Settings screen — working hours, work days and hints

**Files:**
- Modify: `web/src/time.js`, `web/src/time.test.js`, `web/src/components/SettingsPanel.jsx`, `web/src/components/SettingsPanel.test.jsx`

**Interfaces:**
- Consumes: `GET/PUT /admin/settings` with `work_end`, `work_days` (Task 1); `GET /admin/ghl-connection` with `unknown_active_users` (Task 5).
- Produces (in `web/src/time.js`, used by Tasks 7–8):
  - `formatTime(ts: number, timeZone?: string): string` → `"09:05"` (24 h, the location's zone; `"—"` for a falsy `ts`)
  - `formatIdle(sec: number|null): string` → `"—"` (null), `"45 د"`, `"1 س 5 د"`, `"2 س"`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/time.test.js`:

```js
import { formatTime, formatIdle } from "./time.js";

describe("formatTime", () => {
  it("shows the wall-clock time in the given zone", () => {
    const ts = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 05:05Z
    expect(formatTime(ts, "Asia/Dubai")).toBe("09:05");
    expect(formatTime(ts, "UTC")).toBe("05:05");
  });
  it("shows a dash without a timestamp", () => {
    expect(formatTime(null, "UTC")).toBe("—");
  });
});

describe("formatIdle", () => {
  it("formats minutes and hours, and a dash for no value", () => {
    expect(formatIdle(null)).toBe("—");
    expect(formatIdle(0)).toBe("0 د");
    expect(formatIdle(45 * 60 + 20)).toBe("45 د");
    expect(formatIdle(65 * 60)).toBe("1 س 5 د");
    expect(formatIdle(120 * 60)).toBe("2 س");
  });
});
```

(If `time.test.js` already imports from `./time.js` at the top, add `formatTime, formatIdle` to that import instead of a second import line.)

Append to `web/src/components/SettingsPanel.test.jsx` (inside the existing `describe("SettingsPanel", …)`):

```js
  const WH = { ...BASE, work_end: "17:00", work_days: 127, activity_monitoring: true, idle_minutes: 30 };

  it("shows the working-day end and the seven work-day boxes", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نهاية الدوام (HH:MM)")).toHaveValue("17:00");
    for (const d of ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"]) {
      expect(screen.getByLabelText(d)).toBeChecked();
    }
  });

  it("sends work_end and the work-day bitmask (Friday off = 95)", async () => {
    const api = {
      get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })),
      put: vi.fn(async (_p, b) => ({ ...WH, ...b })),
    };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByLabelText("الجمعة"));
    fireEvent.change(screen.getByLabelText("نهاية الدوام (HH:MM)"), { target: { value: "16:30" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toMatchObject({ work_end: "16:30", work_days: 95 });
  });

  it("hints that working hours are needed while monitoring is on without an end", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...WH, work_end: null } : { installed: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByText("حدّد بداية ونهاية الدوام لتشتغل تنبيهات العمل بدون دوام")).toBeInTheDocument();
  });

  it("counts active GHL users who never opened TimeClock", async () => {
    const conn = { installed: true, has_activity_scope: true, last_event_at: null, events_24h: 3, unknown_active_users: 2 };
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? WH : conn)), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByText("في نشاط بآخر 7 أيام من 2 مستخدمين ما فتحوا TimeClock بعد")).toBeInTheDocument();
  });

  it("explains an invalid working-day end", async () => {
    const err = Object.assign(new Error("INVALID_WORK_END"), { code: "INVALID_WORK_END" });
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })), put: vi.fn(async () => { throw err; }) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText("نهاية الدوام غير صحيحة (لازم تكون بعد البداية)")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `cd web && npx vitest run src/time.test.js src/components/SettingsPanel.test.jsx`
Expected: FAIL — `formatTime` is not exported; the new labels are not found.

- [ ] **Step 3: Implement the formatters**

Append to `web/src/time.js`:

```js
export function formatTime(ts, timeZone) {
  if (!ts) return "—";
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return new Intl.DateTimeFormat("en-GB", timeZone ? { ...opts, timeZone } : opts).format(new Date(Number(ts) * 1000));
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(Number(ts) * 1000));
  }
}
export function formatIdle(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return "—";
  const m = Math.floor(Number(sec) / 60);
  if (m < 60) return `${m} د`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} س ${mm} د` : `${h} س`;
}
```

- [ ] **Step 4: Implement the settings fields**

In `web/src/components/SettingsPanel.jsx`:

1. Above `export default function SettingsPanel`, add:

```js
// Saturday first, as the week reads in the region; bit = JavaScript getDay() (0 = Sunday).
const WEEK = [["السبت", 6], ["الأحد", 0], ["الاثنين", 1], ["الثلاثاء", 2], ["الأربعاء", 3], ["الخميس", 4], ["الجمعة", 5]];
```

2. In `save()`, add to the PUT body (after `work_start`):

```js
        work_end: s.work_end || null,
        work_days: s.work_days ?? 127,
```

and add to the error mapping (before the final fallback):

```js
        : e.code === "INVALID_WORK_END" ? "نهاية الدوام غير صحيحة (لازم تكون بعد البداية)"
        : e.code === "INVALID_WORK_DAYS" ? "اختار يوم دوام واحد على الأقل"
```

3. In the JSX, right after the `work-start` field, add:

```jsx
      <div className="field"><label htmlFor="work-end">نهاية الدوام (HH:MM)</label><input id="work-end" value={s.work_end ?? ""} onChange={set("work_end")} /></div>
      <fieldset className="field days">
        <legend>أيام الدوام</legend>
        {WEEK.map(([name, bit]) => {
          const days = s.work_days ?? 127;
          return (
            <label key={bit}>
              <input type="checkbox" checked={Boolean(days & (1 << bit))}
                onChange={(e) => setS({ ...s, work_days: e.target.checked ? days | (1 << bit) : days & ~(1 << bit) })} />
              {name}
            </label>
          );
        })}
      </fieldset>
```

4. In the connection-status `<div className="field">`, after the "لازم يكون الموظفين عارفين…" line, add:

```jsx
        {s.activity_monitoring && (!s.work_start || !s.work_end) && (
          <p className="hint">حدّد بداية ونهاية الدوام لتشتغل تنبيهات العمل بدون دوام</p>
        )}
        {conn?.unknown_active_users > 0 && (
          <p className="hint">في نشاط بآخر 7 أيام من {conn.unknown_active_users} مستخدمين ما فتحوا TimeClock بعد</p>
        )}
```

(The test matches the whole text node; React renders `{conn.unknown_active_users}` adjacent to the strings inside one `<p>`, and `findByText` matches the element's full text content.)

5. In `web/src/styles.css`, after the `.field.check` rules, add:

```css
.field.days{display:flex; flex-wrap:wrap; gap:8px 14px; border:0; padding:0; margin:0 0 12px}
.field.days legend{width:100%; margin-bottom:6px; font-weight:600}
.field.days label{display:flex; align-items:center; gap:6px; font-weight:400}
```

- [ ] **Step 5: Run the frontend tests and build**

Run: `cd web && npx vitest run && cd .. && npm run build`
Expected: **0 failed** — baseline 99 + 8 new (3 in `time.test.js`, 5 in `SettingsPanel.test.jsx`) = **107 passed**; build OK.

- [ ] **Step 6: Commit**

```bash
git add web/src/time.js web/src/time.test.js web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx web/src/styles.css
git commit -m "feat(settings-ui): working-day end, work days and activity hints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Manager screens — alerts panel, live-floor chips, session columns

**Files:**
- Create: `web/src/components/AlertsPanel.jsx`, `web/src/components/AlertsPanel.test.jsx`
- Modify: `web/src/components/ManagerDashboard.jsx`, `web/src/components/LiveFloor.jsx`, `web/src/components/LiveFloor.test.jsx`, `web/src/components/ReportPanel.jsx`, `web/src/components/ReportPanel.test.jsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: `GET /admin/alerts`, `POST /admin/alerts/:id/dismiss` (Tasks 3–4); `/admin/live` fields `idle_minutes`, `idle_sec`, `active_without_session` (Task 5); `/admin/sessions` fields `activity_count`, `longest_idle_sec` (Task 5); `formatTime`, `formatIdle` (Task 6).
- Produces: `<AlertsPanel api />` — renders nothing while there are no open alerts.

- [ ] **Step 1: Write the failing tests**

`web/src/components/AlertsPanel.test.jsx`:

```js
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import AlertsPanel from "./AlertsPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);
const at = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 09:05 in Dubai

describe("AlertsPanel", () => {
  it("renders nothing without open alerts", async () => {
    const api = { get: vi.fn(async () => ({ alerts: [], timezone: "Asia/Dubai" })), post: vi.fn() };
    const { container } = wrap(<AlertsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/admin/alerts?status=open"));
    expect(container.querySelector(".alerts")).toBeNull();
  });

  it("lists an open alert with the time in the location's zone and the employee's note", async () => {
    const api = {
      get: vi.fn(async () => ({
        alerts: [{ id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: at, employee_note: "كنت عم رد من الموبايل" }],
        timezone: "Asia/Dubai",
      })),
      post: vi.fn(),
    };
    wrap(<AlertsPanel api={api} />);
    expect(await screen.findByText("تنبيهات النشاط")).toBeInTheDocument();
    expect(screen.getByText("سارة")).toBeInTheDocument();
    expect(screen.getByText("عم يشتغل بدون دوام من 09:05")).toBeInTheDocument();
    expect(screen.getByText("كنت عم رد من الموبايل")).toBeInTheDocument();
  });

  it("dismisses an alert and removes it", async () => {
    const api = {
      get: vi.fn(async () => ({ alerts: [{ id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" })),
      post: vi.fn(async () => ({ ok: true })),
    };
    wrap(<AlertsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "تجاهل" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/alerts/a1/dismiss"));
    await waitFor(() => expect(screen.queryByText("سارة")).not.toBeInTheDocument());
  });
});
```

Append to `web/src/components/LiveFloor.test.jsx` (inside `describe`):

```js
  it("flags a working employee idle past the threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now, idle_minutes: 30,
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 7200, idle_sec: 45 * 60 }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("بدون نشاط 45 د")).toBeInTheDocument();
  });

  it("does not flag idle time under the threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now, idle_minutes: 30,
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 7200, idle_sec: 10 * 60 }],
    })) };
    render(<LiveFloor api={api} />);
    await screen.findByText("أحمد");
    expect(screen.queryByText(/بدون نشاط/)).not.toBeInTheDocument();
  });

  it("marks an offline employee who is active without a session", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now, idle_minutes: 30,
      employees: [{ user_id: "b", name: "سارة", session_id: null, started_at: null, active_without_session: true }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("نشِط بدون دوام")).toBeInTheDocument();
    expect(screen.getByText("غير متصل").closest(".lane").textContent).toContain("سارة");
  });
```

Append to `web/src/components/ReportPanel.test.jsx` (inside `describe`; it uses the file's own `makeApi`):

```js
  it("shows each session's activity count and longest idle stretch", async () => {
    const session = { started_at: 1000, ended_at: 4600, break_sec: 0, closed_by: "user", note: null, late_by_sec: null };
    const api = makeApi({
      sessions: [
        { ...session, id: "s1", activity_count: 4, longest_idle_sec: 65 * 60 },
        { ...session, id: "s2", activity_count: null, longest_idle_sec: null },
      ],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByRole("columnheader", { name: "النشاط" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "أطول خمول" })).toBeInTheDocument();
    expect(screen.getByText("1 س 5 د")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `cd web && npx vitest run src/components/AlertsPanel.test.jsx src/components/LiveFloor.test.jsx src/components/ReportPanel.test.jsx`
Expected: FAIL — `AlertsPanel.jsx` missing; chips and columns not rendered.

- [ ] **Step 3: Implement `AlertsPanel`**

`web/src/components/AlertsPanel.jsx`:

```jsx
import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatTime } from "../time.js";

// Open "working, not clocked in" alerts (spec §6). Hidden while there are none.
export default function AlertsPanel({ api }) {
  const [data, setData] = useState({ alerts: [], timezone: null });
  const toast = useToast();

  async function load() {
    const d = await api.get("/admin/alerts?status=open");
    setData({ alerts: d.alerts ?? [], timezone: d.timezone ?? null });
  }
  useEffect(() => {
    load().catch(() => {});
    const poll = setInterval(() => load().catch(() => {}), 60000);
    return () => clearInterval(poll);
  }, []);

  async function dismiss(id) {
    try {
      await api.post(`/admin/alerts/${id}/dismiss`);
      setData((d) => ({ ...d, alerts: d.alerts.filter((a) => a.id !== id) }));
      toast("تم تجاهل التنبيه");
    } catch {
      // Already handled elsewhere (dismissed in another tab, or resolved by clock-in): resync.
      await load().catch(() => {});
    }
  }

  if (!data.alerts.length) return null;
  return (
    <section className="panel alerts" aria-label="تنبيهات النشاط">
      <div className="panel-h"><h2>تنبيهات النشاط</h2><b className="count">{data.alerts.length}</b></div>
      {data.alerts.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{a.name || a.user_id}</div>
            <div className="m">عم يشتغل بدون دوام من {formatTime(a.from_at, data.timezone)}</div>
            {a.employee_note && <div className="note">{a.employee_note}</div>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => dismiss(a.id)}>تجاهل</Button>
        </div>
      ))}
    </section>
  );
}
```

Note: the test asserts `getByText("عم يشتغل بدون دوام من 09:05")` — the `.m` div renders the text and the time as adjacent text nodes in one element, which `getByText` matches on the element's full text.

In `web/src/components/ManagerDashboard.jsx`, import it and render it first:

```jsx
import AlertsPanel from "./AlertsPanel.jsx";
import LiveFloor from "./LiveFloor.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

export default function ManagerDashboard({ api }) {
  return (
    <div className="grid">
      <AlertsPanel api={api} />
      <LiveFloor api={api} />
      <ReportPanel api={api} />
      <SettingsPanel api={api} />
    </div>
  );
}
```

- [ ] **Step 4: Live-floor chips**

In `web/src/components/LiveFloor.jsx`:

1. Add `formatIdle` to the `../time.js` import.
2. Inside the component, after `const inFixed = …`, add:

```js
  // idle_sec is exact at server_time; it keeps growing between polls unless on a break.
  const idleNow = (p) => (p.idle_sec == null ? null : p.idle_sec + (p.break_started_at || inFixed ? 0 : Math.max(0, nowS - data.server_time)));
  const isIdle = (p) => data.idle_minutes != null && idleNow(p) != null && idleNow(p) >= data.idle_minutes * 60;
```

3. Replace the `{live && (…)}` expression with:

```jsx
            {live && (p.break_started_at
              ? <div className="m break">استراحة · {formatDuration(nowS - p.break_started_at)}</div>
              : inFixed
                ? <div className="m break">وقت الاستراحة</div>
                : <div className="m">{formatDuration(nowS - p.started_at)}</div>)}
            {live && !p.break_started_at && !inFixed && isIdle(p) && (
              <div className="m warn">بدون نشاط {formatIdle(idleNow(p))}</div>
            )}
            {!live && p.active_without_session && <div className="m warn">نشِط بدون دوام</div>}
```

4. In `web/src/styles.css`, next to `.person .m.break`, add:

```css
.person .m.warn{color:var(--warn); font-weight:600}
.alerts .panel-h .count{color:var(--warn)}
.alert-row{display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line, #E3E0F0)}
.alert-row .m{font-size:13px; color:var(--warn)}
.alert-row .note{font-size:13px; color:var(--muted); margin-top:4px}
```

(Use the existing border token if `styles.css` defines one — check `:root`; keep the fallback only if none exists.)

- [ ] **Step 5: Session columns**

In `web/src/components/ReportPanel.jsx`:

1. Add `formatIdle` to the `../time.js` import.
2. In the detail table header, after `<th scope="col">التأخير</th>`, add `<th scope="col">النشاط</th><th scope="col">أطول خمول</th>`.
3. In each detail row, after the lateness cell, add:

```jsx
                <td className="num">{s.activity_count ?? "—"}</td>
                <td>{formatIdle(s.longest_idle_sec)}</td>
```

- [ ] **Step 6: Run the frontend tests and build**

Run: `cd web && npx vitest run && cd .. && npm run build`
Expected: **0 failed** — Task 6's 107 + 7 new (3 AlertsPanel, 3 LiveFloor, 1 ReportPanel) = **114 passed**; build OK.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/AlertsPanel.jsx web/src/components/AlertsPanel.test.jsx web/src/components/ManagerDashboard.jsx web/src/components/LiveFloor.jsx web/src/components/LiveFloor.test.jsx web/src/components/ReportPanel.jsx web/src/components/ReportPanel.test.jsx web/src/styles.css
git commit -m "feat(manager-ui): activity alerts panel, idle and active-without-session chips, session activity columns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Employee screen — "start your day?" banner, note, monitoring line

**Files:**
- Modify: `web/src/components/EmployeeScreen.jsx`, `web/src/components/EmployeeScreen.test.jsx`

**Interfaces:**
- Consumes: `GET /me/alerts`, `POST /me/alerts/:id/note` (Task 4); `/me/status.activity_monitoring` (Task 5); `formatTime` (Task 6).

- [ ] **Step 1: Write the failing tests**

The file's `makeApi(status, …)` answers every unknown path with `status`, so existing tests keep working once the screen also calls `/me/alerts` (the component reads `alerts ?? []`). Add, below `makeApi`:

```js
// Answers /me/alerts with `alerts` (an Error rejects) and everything else like `api`.
function withAlerts(api, alerts) {
  const base = api.get;
  api.get = vi.fn((path) => (path && path.startsWith("/me/alerts")
    ? (alerts instanceof Error ? Promise.reject(alerts) : Promise.resolve(alerts))
    : base(path)));
  return api;
}
```

and inside `describe("EmployeeScreen", …)`:

```js
  it("asks an employee working without a session to start the day", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 09:05 Dubai
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "Asia/Dubai" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("مبيّن إنك عم تشتغل من 09:05. بتبلّش الدوام؟")).toBeInTheDocument();
  });

  it("sends the employee's note on the alert", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000;
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.change(await screen.findByLabelText("ملاحظة للمدير"), { target: { value: "كنت عم رد من الموبايل" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الملاحظة" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/me/alerts/a1/note", { note: "كنت عم رد من الموبايل" }));
  });

  it("says so while activity monitoring is on", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: nowSec(), activity_monitoring: true });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("مراقبة النشاط مفعّلة")).toBeInTheDocument();
  });

  it("still works when the alerts request fails", async () => {
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }), new Error("down"));
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /بدء الدوام/ })).toBeInTheDocument();
    expect(screen.queryByText("حدث خطأ، حاول مرة أخرى")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `cd web && npx vitest run src/components/EmployeeScreen.test.jsx`
Expected: the four new tests FAIL (banner, note box, line missing).

- [ ] **Step 3: Implement**

In `web/src/components/EmployeeScreen.jsx`:

1. Add `formatTime` to the `../time.js` import.
2. Add state: `const [alerts, setAlerts] = useState({ list: [], timezone: null });` and `const [alertNote, setAlertNote] = useState("");`
3. In `refresh()`, at the end, add:

```js
    // Alerts are a convenience: a failure here never blocks clocking in.
    try {
      const a = await api.get("/me/alerts");
      setAlerts({ list: a.alerts ?? [], timezone: a.timezone ?? null });
    } catch {
      setAlerts({ list: [], timezone: null });
    }
```

4. Add a handler:

```js
  async function sendAlertNote(id) {
    const note = alertNote.trim();
    if (!note) return;
    try {
      await api.post(`/me/alerts/${id}/note`, { note });
      setAlertNote("");
      toast("وصلت ملاحظتك للمدير");
    } catch (e) {
      setError(e.code === "NOTE_TOO_LONG" ? "الملاحظة طويلة جداً" : GENERIC_ERROR);
    }
  }
```

5. After `const showBreak = …`, add `const nci = !open ? alerts.list.find((a) => a.kind === "working_not_clocked_in") : null;`
6. In the JSX, right after the closing `</div>` of `.hero`, add:

```jsx
      {nci && (
        <section className="panel notice" role="status">
          <p>مبيّن إنك عم تشتغل من {formatTime(nci.from_at, alerts.timezone)}. بتبلّش الدوام؟</p>
          <div className="actions">
            <Button onClick={toggle} loading={loading} size="lg"><Icon name="play" />بدء الدوام</Button>
          </div>
          <div className="field">
            <label htmlFor="alert-note">ملاحظة للمدير</label>
            <textarea id="alert-note" maxLength={300} value={alertNote} onChange={(e) => setAlertNote(e.target.value)} />
          </div>
          <Button variant="ghost" size="sm" onClick={() => sendAlertNote(nci.id)}>إرسال الملاحظة</Button>
        </section>
      )}
```

7. Inside `.hero`, after the fixed-break `<p className="hint">` (still inside the first child `<div>`), add:

```jsx
          {status?.activity_monitoring && <p className="hint">مراقبة النشاط مفعّلة</p>}
```

8. In `web/src/styles.css` add:

```css
.panel.notice{border-color:var(--warn); background:var(--warn-soft)}
.panel.notice p{margin:0 0 12px; font-weight:600; color:var(--warn)}
```

The existing hero "بدء الدوام" button stays; the banner's button calls the same `toggle()` (it starts **now**). After a successful start, `refresh()` reloads `/me/alerts`, which is empty because the server resolved the alert, so the banner disappears.

- [ ] **Step 4: Run the frontend tests and build**

Run: `cd web && npx vitest run && cd .. && npm run build`
Expected: **0 failed** — Task 7's 114 + 4 = **118 passed**; build OK. If an existing EmployeeScreen test asserts an exact number of `api.get` calls, raise it by the one `/me/alerts` call per refresh.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx web/src/styles.css
git commit -m "feat(employee-ui): start-your-day banner with a note to the manager, monitoring notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Handoff docs and full verification

**Files:**
- Modify: `CLAUDE.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`

- [ ] **Step 1: Full verification**

```bash
npm run test:unit
cd web && npx vitest run && cd ..
npm run build
# restart the API, then:
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|SKIP|passed"
```

Expected: unit **49**/0; frontend **118**/0; build OK; smoke **169 passed, 0 failed** (only the documented SKIPs: foreign-appId without `GHL_APP_ID`, and time-of-day guards if near midnight).

Then run the smoke test once more against a production-mode server to confirm the test-key blocks skip cleanly:

```bash
pkill -f "node --env-file=.env src/server.js"; NODE_ENV=production nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health >/dev/null; do sleep 1; done
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|passed"
```

Expected: **0 failed**. (`NODE_ENV=production` on the command line overrides `.env`; restart normally afterwards.)

- [ ] **Step 2: Update the context files**

- `CLAUDE.md` → folder structure: add `src/activity.js        # activity rules: working hours, event freshness, idle time, session summary (pure)` under `src/tokenCrypto.js`, and `AlertsPanel` to the components list. In "Commands", the unit-test comment gains "activity rules".
- `docs/DECISIONS.md` → append:

```markdown
## 2026-10-02 — Phase B: one alert, idle as information, absent settings fields are kept
- **Decision:** phase B raises only "working, not clocked in", and only inside working hours
  (`work_start`–`work_end` on `work_days`, location time). Idle time is shown (live chip, session
  columns) but never alerts; the idle alert and "end at last activity" are deferred (spec §11).
  `PUT /admin/settings` keeps any field absent from the body.
- **Reason:** on Innova only Instagram and Email reach us, so silence is weak evidence; an alert with
  an "end session" button is the closest thing to a pay deduction. Out-of-hours work is not the
  manager's concern (owner). "Absent = keep" stops an older page from resetting newer fields.
- **Rejected:** the 2026-09-29 idle alert as drafted; deriving the end of day from `daily_target_hours`
  (approximate); a 3-events-in-30-minutes trigger (owner preferred working hours).
```

- `docs/PROGRESS.md` → update **Current State** (phase B merged locally, migration 005 pending in production, then push, then Innova sets "نهاية الدوام" and "أيام الدوام") and add a Session Log entry with the commit list and the final test counts.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/PROGRESS.md docs/DECISIONS.md
git commit -m "docs: record activity monitoring phase B

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Deployment is the owner's step**

Do **not** push. Report to the owner, in this order: (1) run `migrations/005_working_hours.sql` in phpMyAdmin on production; (2) then push `main`; (3) check `/health` and that `/admin/alerts` answers 401 without a token; (4) in Innova's TimeClock settings set "نهاية الدوام" and "أيام الدوام". Then record 005 as applied in `migrations/README.md`.
