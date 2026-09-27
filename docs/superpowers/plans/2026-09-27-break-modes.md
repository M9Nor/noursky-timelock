# Break Modes (off / fixed / flexible) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the on/off break toggle with a `break_mode` setting — `off`, `fixed` (manager-set daily window, paid or unpaid, no button) or `flexible` (the existing employee button).

**Architecture:** One migration (break-mode columns on `settings`, a `kind` + generated `fixed_key` on `breaks`). An unpaid fixed window is *materialized* as a `breaks` row (`kind = 'fixed'`) once it has begun for an open session, or when a manager edit puts a session over it — so every existing worked-time query (report, detail, CSV, history) deducts it with no change, and later policy changes never rewrite history. `src/tz.js` gains local-date → UTC helpers for the daily window (DST-aware). The employee and live-floor screens learn today's window from `/me/status` / `/admin/live` and pause the live clock during an unpaid window; the live-total math moves into a pure, unit-tested `liveTotals()`.

**Tech Stack:** Node 20 ESM · Hono 4 · mysql2 (named placeholders, `decimalNumbers: true`) · React 18 · Vite 5 · Vitest 2 + React Testing Library · `node:test` for `src/tz.js` · MariaDB 11 locally (Docker `timeclock-db`), MariaDB on Hostinger in production

**Spec:** `docs/superpowers/specs/2026-09-24-attendance-policies-design.md` §5.4b (with §5.4, §6)

## Global Constraints

- Plain ESM JavaScript, 2-space indent, semicolons. No TypeScript, no backend build step.
- SQL must run on **both MySQL 8 and MariaDB 10.2+**. No partial indexes, `UPDATE ... RETURNING`, `INSERT ... AS alias ON DUPLICATE KEY`, or `ADD COLUMN IF NOT EXISTS`.
- `location_id` and `user_id` come only from `c.get("claims")`. Every `/admin/*` route keeps `authed, managerOnly`. Transactions + `SELECT … FOR UPDATE` for read-then-write.
- Errors are `{ error: "CODE" }` via `HttpError`; every new code is documented in `PROJECT.md` §8.
- All timestamps are UNIX seconds (UTC). The fixed window is `HH:MM` in the **location timezone**, same day, start < end.
- UI: Arabic, RTL, Western digits; live timers anchored on `server_time`.
- Spec §5.4b values, verbatim: `break_mode` ∈ `off` / `fixed` / `flexible` (default `off`); `break_start`, `break_end` `HH:MM` or null; `break_paid` boolean (default false); `settings.breaks_enabled` kept equal to `break_mode = 'flexible'`.
- **Migration order is mandatory: database first, then code.** Migration 003 must be applied to production before this code ships.
- Never commit secrets or `.env`.

## Shared commands

Restart the local API after changing `src/server.js`:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
pkill -f "node --env-file=.env src/server.js"; nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health >/dev/null; do sleep 1; done; echo up
```

Smoke test (Docker `timeclock-db` running, API up):

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke 2>&1 | grep -E "FAIL|SKIP|passed"
```

Unit tests: `npm run test:unit`. Frontend: `cd web && npx vitest run`.

Baseline before Task 1: unit **8**, smoke **66 passed, 0 failed**, frontend **80 passed**.

## File map

| File | Change |
|---|---|
| `src/tz.js`, `src/tz.test.mjs` | `localDate`, `wallToUtc`, `fixedWindows` (T1) |
| `migrations/003_break_modes.sql`, `migrations/README.md`, `schema.sql` | DDL (T2) |
| `src/server.js` | settings + break gating (T2); materialization, stop clip, `fixed_break` in status/live (T3) |
| `scripts/smoke-test.mjs` | break-mode fixture block (T2, T3) |
| `PROJECT.md` | §7, §8, §9 (T2, T3) |
| `web/src/components/SettingsPanel.jsx` (+test) | break-mode select, window, paid (T4) |
| `web/src/time.js` (+test) | `liveTotals` (T5) |
| `web/src/components/EmployeeScreen.jsx` (+test), `LiveFloor.jsx` (+test) | fixed window display + pause (T5) |

---

### Task 1: Timezone helpers for a daily local window

**Files:**
- Modify: `src/tz.js`, `src/tz.test.mjs`

**Interfaces:**
- Produces (exported from `src/tz.js`):
  - `localDate(tz, ts) → { y, m, d }` — local calendar date of UNIX seconds `ts`.
  - `wallToUtc(tz, { y, m, d }, "HH:MM") → number` — UTC seconds of that local wall-clock time (DST-aware).
  - `fixedWindows(tz, fromTs, toTs, "HH:MM", "HH:MM") → Array<[startTs, endTs]>` — the daily window for every local date from `localDate(fromTs)` to `localDate(toTs)` inclusive, in date order.

- [ ] **Step 1: Write the failing tests**

In `src/tz.test.mjs`, change the import to

```js
import { tzOffsetSec, tzSegments, localZone, localDate, wallToUtc, fixedWindows } from "./tz.js";
```

and append:

```js
test("localDate returns the local calendar date", () => {
  // 22:30Z on the 24th is already the 25th in Riyadh (UTC+3).
  assert.deepEqual(localDate("Asia/Riyadh", utc(2026, 8, 24, 22, 30)), { y: 2026, m: 9, d: 25 });
  assert.deepEqual(localDate("UTC", utc(2026, 8, 24, 22, 30)), { y: 2026, m: 9, d: 24 });
});

test("wallToUtc converts a local wall-clock time, DST-aware", () => {
  assert.equal(wallToUtc("Asia/Riyadh", { y: 2026, m: 9, d: 24 }, "13:00"), utc(2026, 8, 24, 10));
  // Berlin is UTC+1 in winter and UTC+2 in summer.
  assert.equal(wallToUtc("Europe/Berlin", { y: 2026, m: 3, d: 20 }, "13:00"), utc(2026, 2, 20, 12));
  assert.equal(wallToUtc("Europe/Berlin", { y: 2026, m: 4, d: 10 }, "13:00"), utc(2026, 3, 10, 11));
});

test("fixedWindows yields one window per local date the range touches", () => {
  // 09:00 local on the 24th to 17:00 local on the 25th, Riyadh.
  const w = fixedWindows("Asia/Riyadh", utc(2026, 8, 24, 6), utc(2026, 8, 25, 14), "13:00", "14:00");
  assert.deepEqual(w, [
    [utc(2026, 8, 24, 10), utc(2026, 8, 24, 11)],
    [utc(2026, 8, 25, 10), utc(2026, 8, 25, 11)],
  ]);
  assert.equal(fixedWindows("Asia/Riyadh", utc(2026, 8, 24, 6), utc(2026, 8, 24, 14), "13:00", "14:00").length, 1);
});

test("fixedWindows follows DST across a change", () => {
  const w = fixedWindows("Europe/Berlin", utc(2026, 2, 28, 9), utc(2026, 2, 29, 15), "13:00", "14:00");
  assert.deepEqual(w, [
    [utc(2026, 2, 28, 12), utc(2026, 2, 28, 13)], // CET
    [utc(2026, 2, 29, 11), utc(2026, 2, 29, 12)], // CEST from the 29th
  ]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `localDate` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement**

Append to `src/tz.js`:

```js
/** Local calendar date { y, m, d } of an instant in a zone. */
export function localDate(tz, ts) {
  const p = Object.fromEntries(
    formatter(tz).formatToParts(new Date(Math.floor(Number(ts)) * 1000)).map((x) => [x.type, x.value])
  );
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** UTC seconds of a local wall-clock time ("HH:MM") on a local date. DST-aware. */
export function wallToUtc(tz, { y, m, d }, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  // Two passes: the first lands within one offset of the answer, the second uses the
  // offset actually in force at that instant (they differ only around a DST change).
  const first = asIfUtc - tzOffsetSec(tz, new Date(asIfUtc * 1000));
  return asIfUtc - tzOffsetSec(tz, new Date(first * 1000));
}

/** A daily local window as UTC [start, end] pairs, one per local date in [fromTs, toTs]. */
export function fixedWindows(tz, fromTs, toTs, start, end) {
  const out = [];
  const key = (x) => x.y * 10000 + x.m * 100 + x.d;
  const last = key(localDate(tz, toTs));
  for (let cur = localDate(tz, fromTs); key(cur) <= last;) {
    out.push([wallToUtc(tz, cur, start), wallToUtc(tz, cur, end)]);
    const next = new Date(Date.UTC(cur.y, cur.m - 1, cur.d + 1));
    cur = { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:unit`
Expected: **12 passed, 0 failed**.

- [ ] **Step 5: Commit**

```bash
git add src/tz.js src/tz.test.mjs
git commit -m "feat(tz): local date and wall-clock-to-UTC helpers for daily windows"
```

---

### Task 2: Migration 003 + break-mode settings API

**Files:**
- Create: `migrations/003_break_modes.sql`
- Modify: `migrations/README.md`, `schema.sql`, `src/server.js` (`getSettings`, `/me/settings`, `/session/break/start`, `PUT /admin/settings`), `scripts/smoke-test.mjs`, `PROJECT.md`

**Interfaces:**
- Consumes: existing phase-2 schema (`breaks`, `settings.breaks_enabled`).
- Produces:
  - Columns `settings.break_mode` ENUM('off','fixed','flexible'), `settings.break_start` CHAR(5) NULL, `settings.break_end` CHAR(5) NULL, `settings.break_paid` TINYINT(1); `breaks.kind` ENUM('employee','fixed'), generated `breaks.fixed_key`, `UNIQUE ux_fixed_window (session_id, fixed_key)`.
  - `getSettings(loc)` returns `break_paid` as boolean (and `breaks_enabled` as before).
  - `GET /me/settings` adds `break_mode`, `break_start`, `break_end`, `break_paid`.
  - `PUT /admin/settings` accepts `break_mode`, `break_start`, `break_end`, `break_paid`; errors `400 INVALID_BREAK_MODE`, `400 INVALID_BREAK_WINDOW`, `400 INVALID_BREAKS` (non-boolean `break_paid` or `breaks_enabled`). A body without `break_mode` but with `breaks_enabled: true` means `flexible`.
  - `POST /session/break/start` → `403 BREAKS_DISABLED` unless `break_mode = 'flexible'`.
  - Smoke fixture constants `FXLOC`, `FM` (manager token), `FE` (employee token), `fxPolicy(extra)` and the line `await cleanupLocation(FXLOC);` that Task 3 inserts before.

- [ ] **Step 1: Write the migration**

Create `migrations/003_break_modes.sql`:

```sql
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
```

In `migrations/README.md`, append to the `## Applied` table:

```markdown
| `003_break_modes.sql` | pending | apply before deploying break modes |
```

- [ ] **Step 2: Mirror it in `schema.sql`**

In `CREATE TABLE IF NOT EXISTS settings`, after the `note_on_stop` line add:

```sql
  break_mode         ENUM('off','fixed','flexible') NOT NULL DEFAULT 'off',
  break_start        CHAR(5)      NULL,
  break_end          CHAR(5)      NULL,
  break_paid         TINYINT(1)   NOT NULL DEFAULT 0,
```

In `CREATE TABLE IF NOT EXISTS breaks`, after the `location_id` line add:

```sql
  kind        ENUM('employee','fixed') NOT NULL DEFAULT 'employee',
```

and after the `open_flag` line add:

```sql
  -- Started_at for fixed rows, NULL for employee breaks: one row per session per window.
  fixed_key   BIGINT GENERATED ALWAYS AS (IF(kind = 'fixed', started_at, NULL)) STORED,
```

and after `UNIQUE KEY ux_one_open_break (session_id, open_flag),` add:

```sql
  UNIQUE KEY ux_fixed_window (session_id, fixed_key),
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
set -a; . ./.env; set +a
docker exec -i timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/003_break_modes.sql
docker exec timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "SHOW COLUMNS FROM settings LIKE 'break_%'; SHOW COLUMNS FROM breaks LIKE 'kind';"
```

Expected: `break_mode`, `break_start`, `break_end`, `break_paid` and `kind` listed.

- [ ] **Step 4: Write the failing settings checks**

In `scripts/smoke-test.mjs`, find `await cleanupLocation(P2LOC);` and insert immediately **after** it:

```js

// --- Break modes (spec §5.4b): off / fixed / flexible. Own location; removed at the end.
const FXLOC = `${LOC}-fx`;
const fxMgr = await sso({ userId: `${FXLOC}-m1`, role: "admin", type: "account", activeLocation: FXLOC, userName: "مدير الاستراحة", email: "fm@x.com" });
const fxEmp = await sso({ userId: `${FXLOC}-u1`, role: "user", type: "account", activeLocation: FXLOC, userName: "موظف الاستراحة", email: "fe@x.com" });
const FM = fxMgr.body?.token, FE = fxEmp.body?.token;
const fxBase = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: null, late_grace_minutes: 15, note_on_stop: "off" };
const fxPolicy = (extra) => call(FM, "PUT", "/admin/settings", { ...fxBase, ...extra });

const fxDefaults = await call(FM, "GET", "/admin/settings");
check("break mode defaults to off",
  fxDefaults.body?.break_mode === "off" && fxDefaults.body?.break_paid === false && fxDefaults.body?.break_start === null,
  `(${JSON.stringify(fxDefaults.body)})`);
const fxSaved = await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false });
check("fixed break window saved",
  fxSaved.status === 200 && fxSaved.body?.break_mode === "fixed" && fxSaved.body?.break_start === "13:00"
    && fxSaved.body?.break_end === "14:00" && fxSaved.body?.break_paid === false && fxSaved.body?.breaks_enabled === false,
  `(${JSON.stringify(fxSaved.body)})`);
check("fixed mode without a window → 400",
  (await fxPolicy({ break_mode: "fixed" })).body?.error === "INVALID_BREAK_WINDOW");
check("fixed window ending before it starts → 400",
  (await fxPolicy({ break_mode: "fixed", break_start: "14:00", break_end: "13:00" })).body?.error === "INVALID_BREAK_WINDOW");
check("malformed window time → 400",
  (await fxPolicy({ break_mode: "fixed", break_start: "1pm", break_end: "14:00" })).body?.error === "INVALID_BREAK_WINDOW");
check("unknown break mode → 400", (await fxPolicy({ break_mode: "sometimes" })).body?.error === "INVALID_BREAK_MODE");
check("non-boolean break_paid → 400",
  (await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: "yes" })).body?.error === "INVALID_BREAKS");
const fxLegacy = await fxPolicy({ breaks_enabled: true });
check("a body with only breaks_enabled: true still means flexible",
  fxLegacy.body?.break_mode === "flexible" && fxLegacy.body?.breaks_enabled === true, `(${JSON.stringify(fxLegacy.body)})`);
await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: true });
const fxMe = await call(FE, "GET", "/me/settings");
check("employee sees the break mode and window",
  fxMe.body?.break_mode === "fixed" && fxMe.body?.break_start === "13:00" && fxMe.body?.break_end === "14:00" && fxMe.body?.break_paid === true,
  `(${JSON.stringify(fxMe.body)})`);
await call(FE, "POST", "/session/start");
check("the break button is refused in fixed mode",
  (await call(FE, "POST", "/session/break/start")).body?.error === "BREAKS_DISABLED");
await call(FE, "POST", "/session/stop");

await cleanupLocation(FXLOC);
```

- [ ] **Step 5: Run to verify they fail**

Run the smoke command against the currently running (old) API. Expected: the new break-mode checks FAIL (fields missing / values accepted); the 66 earlier checks PASS.

- [ ] **Step 6: Implement settings in `src/server.js`**

Replace `getSettings` (and the `NOTE_POLICIES` line under it) with:

```js
async function getSettings(loc) {
  const rows = await q("SELECT * FROM settings WHERE location_id = :loc", { loc });
  const st = rows[0];
  // TINYINT(1) arrives as 0/1; the API speaks booleans.
  return st ? { ...st, breaks_enabled: Boolean(st.breaks_enabled), break_paid: Boolean(st.break_paid) } : null;
}

const NOTE_POLICIES = ["off", "optional", "required"];
const BREAK_MODES = ["off", "fixed", "flexible"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
```

In `GET /me/settings`, after `note_on_stop: st?.note_on_stop ?? "off",` add:

```js
    break_mode: st?.break_mode ?? "off",
    break_start: st?.break_start ?? null,
    break_end: st?.break_end ?? null,
    break_paid: Boolean(st?.break_paid),
```

In `POST /session/break/start`, replace

```js
  if (!(await getSettings(loc))?.breaks_enabled) throw new HttpError(403, "BREAKS_DISABLED");
```

with

```js
  // Only flexible mode has an employee-driven break; fixed windows are automatic.
  if ((await getSettings(loc))?.break_mode !== "flexible") throw new HttpError(403, "BREAKS_DISABLED");
```

In `PUT /admin/settings`, replace

```js
  if (b.work_start && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.work_start)) throw new HttpError(400, "INVALID_WORK_START");
```

with

```js
  if (b.work_start && !HHMM.test(b.work_start)) throw new HttpError(400, "INVALID_WORK_START");
```

then replace

```js
  const breaks = b.breaks_enabled === undefined ? false : b.breaks_enabled;
  if (typeof breaks !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  const notePolicy = b.note_on_stop === undefined ? "off" : b.note_on_stop;
  if (!NOTE_POLICIES.includes(notePolicy)) throw new HttpError(400, "INVALID_NOTE_POLICY");

  await q(
    `UPDATE settings SET timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         late_grace_minutes = :grace, max_session_hours = :max,
                         breaks_enabled = :breaks, note_on_stop = :notePolicy, updated_at = :t
      WHERE location_id = :loc`,
    { tz: b.timezone, target, ws: b.work_start ?? null, grace, max, breaks: breaks ? 1 : 0, notePolicy, t: now(), loc }
  );
```

with

```js
  if (b.breaks_enabled !== undefined && typeof b.breaks_enabled !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  // A stale tab running the previous bundle sends only breaks_enabled; map it so saving
  // there keeps a flexible-break policy instead of silently switching breaks off.
  const breakMode = b.break_mode ?? (b.breaks_enabled === true ? "flexible" : "off");
  if (!BREAK_MODES.includes(breakMode)) throw new HttpError(400, "INVALID_BREAK_MODE");
  const breakStart = b.break_start || null, breakEnd = b.break_end || null;
  if ((breakStart && !HHMM.test(breakStart)) || (breakEnd && !HHMM.test(breakEnd))) {
    throw new HttpError(400, "INVALID_BREAK_WINDOW");
  }
  // Same-day windows only; zero-padded HH:MM compares correctly as strings.
  if (breakMode === "fixed" && (!breakStart || !breakEnd || breakStart >= breakEnd)) {
    throw new HttpError(400, "INVALID_BREAK_WINDOW");
  }
  const breakPaid = b.break_paid === undefined ? false : b.break_paid;
  if (typeof breakPaid !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  const notePolicy = b.note_on_stop === undefined ? "off" : b.note_on_stop;
  if (!NOTE_POLICIES.includes(notePolicy)) throw new HttpError(400, "INVALID_NOTE_POLICY");

  await q(
    `UPDATE settings SET timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         late_grace_minutes = :grace, max_session_hours = :max,
                         breaks_enabled = :breaksEnabled, break_mode = :breakMode,
                         break_start = :breakStart, break_end = :breakEnd, break_paid = :breakPaid,
                         note_on_stop = :notePolicy, updated_at = :t
      WHERE location_id = :loc`,
    {
      tz: b.timezone, target, ws: b.work_start ?? null, grace, max,
      // Kept in sync so code that still reads breaks_enabled behaves the same.
      breaksEnabled: breakMode === "flexible" ? 1 : 0, breakMode, breakStart, breakEnd,
      breakPaid: breakPaid ? 1 : 0, notePolicy, t: now(), loc,
    }
  );
```

- [ ] **Step 7: Restart and run the smoke test**

Run the restart command, then the smoke command.
Expected: **76 passed, 0 failed** (66 + 10). The phase-2 checks that use `p2Policy(true, …)` still pass through the `breaks_enabled: true` mapping.

- [ ] **Step 8: Document in `PROJECT.md`**

§7 settings table: add rows for `break_mode` (`ENUM('off','fixed','flexible')`, default `off` — نوع الاستراحة: بدون / ثابتة يحددها المدير / مرنة بزر الموظف), `break_start`, `break_end` (`CHAR(5)` `HH:MM` بتوقيت الحساب، إلزامية مع `fixed`، نفس اليوم والبداية قبل النهاية), `break_paid` (`TINYINT(1)`, افتراضي 0 — إذا 1 الاستراحة الثابتة ما بتنخصم), and mark `breaks_enabled` as kept in sync with `break_mode = 'flexible'` for older code (not the source of truth). In the `breaks` subsection add `kind` (`employee` = زر الموظف، `fixed` = نافذة ثابتة غير مدفوعة انسجلت تلقائياً) and `fixed_key` (generated; UNIQUE `(session_id, fixed_key)` = صف واحد لكل جلسة لكل نافذة).

§8: replace the `PUT /admin/settings` row with:

```markdown
| PUT | `/admin/settings` | Body: `{ timezone, daily_target_hours, max_session_hours, work_start, late_grace_minutes, note_on_stop, break_mode, break_start, break_end, break_paid }` — `break_mode` واحد من `off`/`fixed`/`flexible` (افتراضي `off`)؛ مع `fixed` لازم `break_start` و `break_end` (`HH:MM`، البداية قبل النهاية)؛ `break_paid` boolean. إذا الـ body فيه `breaks_enabled: true` بدون `break_mode` بينحسب `flexible` (توافق مع النسخة القديمة). الحقل الناقص = القيمة الافتراضية |
```

Append to the `/session/break/start` row: `— مسموح بس لما \`break_mode = flexible\``. Append to رموز الأخطاء:

```markdown
| `INVALID_BREAK_MODE` | 400 | `break_mode` مش من القيم المسموحة | نوع الاستراحة غير صحيح |
| `INVALID_BREAK_WINDOW` | 400 | وقت الاستراحة الثابتة ناقص أو غلط أو النهاية قبل البداية | وقت الاستراحة غير صحيح |
```

- [ ] **Step 9: Commit**

```bash
git add migrations schema.sql src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(settings): break mode off/fixed/flexible with a fixed window (migration 003)"
```

---

### Task 3: Record unpaid fixed windows and expose today's window

**Files:**
- Modify: `src/server.js` (imports, new helpers, `autoCloseStale`, `/session/stop` break_sec, `PATCH /admin/sessions/:id`, `/me/status`, `/admin/live`), `scripts/smoke-test.mjs`, `PROJECT.md`

**Interfaces:**
- Consumes: `localDate`, `wallToUtc`, `fixedWindows` from `src/tz.js` (Task 1); `break_mode`/`break_start`/`break_end`/`break_paid` and `breaks.kind` + `ux_fixed_window` (Task 2); smoke `FXLOC`, `FM`, `FE`, `fxPolicy`, and the line `await cleanupLocation(FXLOC);`.
- Produces:
  - `GET /me/status` and `GET /admin/live` gain `fixed_break: { starts_at, ends_at, paid } | null` — today's window (local date of `server_time`) when `break_mode = 'fixed'`, else null.
  - Unpaid fixed windows appear in `break_sec` everywhere (`/me/status`, `/me/sessions`, `/admin/sessions`, report, CSV) through `breaks` rows with `kind = 'fixed'`.
  - `POST /session/stop`'s `break_sec` is clipped to the session (a window that runs past the stop counts only up to the stop).

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-test.mjs`, insert immediately **before** `await cleanupLocation(FXLOC);`:

```js
// Unpaid fixed window: recorded as a break when a manager edit puts a session over it.
// Riyadh is UTC+3 with no DST; fxMidnight is 00:00 local "yesterday" as UTC seconds.
const fxMidnight = Math.floor((t + 3 * 3600) / 86400) * 86400 - 86400 - 3 * 3600;
async function fxSessionAt(dayStart) {
  const open = await call(FE, "POST", "/session/start");
  await call(FE, "POST", "/session/stop");
  await call(FM, "PATCH", `/admin/sessions/${open.body?.id}`,
    { started_at: dayStart + 9 * 3600, ended_at: dayStart + 17 * 3600, reason: "نافذة استراحة للاختبار" });
  return open.body?.id;
}
await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false });
const fxUnpaidId = await fxSessionAt(fxMidnight);
const fxRange = `from=${fxMidnight + 9 * 3600}&to=${fxMidnight + 17 * 3600}`;
const fxRows = await call(FM, "GET", `/admin/sessions?${fxRange}&user_id=${FXLOC}-u1`);
check("an unpaid fixed window is deducted from a session that covers it",
  fxRows.body?.sessions?.find((x) => x.id === fxUnpaidId)?.break_sec === 3600,
  `(${JSON.stringify(fxRows.body?.sessions?.map((x) => x.break_sec))})`);
const fxReport = await call(FM, "GET", `/admin/report?${fxRange}`);
check("report worked time excludes the unpaid window",
  fxReport.body?.employees?.find((e) => e.user_id === `${FXLOC}-u1`)?.worked_sec === 7 * 3600,
  `(${JSON.stringify(fxReport.body?.employees?.find((e) => e.user_id === `${FXLOC}-u1`))})`);
await fxPolicy({ break_mode: "off" });
const fxAfterOff = await call(FM, "GET", `/admin/sessions?${fxRange}&user_id=${FXLOC}-u1`);
check("switching the policy off does not rewrite a recorded day",
  fxAfterOff.body?.sessions?.find((x) => x.id === fxUnpaidId)?.break_sec === 3600);

// A paid window deducts nothing.
await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: true });
const fxPaidId = await fxSessionAt(fxMidnight - 86400);
const fxPaidRows = await call(FM, "GET",
  `/admin/sessions?from=${fxMidnight - 86400 + 9 * 3600}&to=${fxMidnight - 86400 + 17 * 3600}&user_id=${FXLOC}-u1`);
check("a paid fixed window deducts nothing",
  fxPaidRows.body?.sessions?.find((x) => x.id === fxPaidId)?.break_sec === 0);

// Live: a window that is running now. Needs a same-day window around the current local
// time, so it is skipped in the last hour before local midnight.
const fxNowLocal = (t + 3 * 3600) % 86400;
if (fxNowLocal >= 120 && fxNowLocal < 23 * 3600) {
  const hhmm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}`;
  const winStart = Math.floor(fxNowLocal / 60) * 60 - 60;
  await fxPolicy({ break_mode: "fixed", break_start: hhmm(winStart), break_end: hhmm(winStart + 3600), break_paid: false });
  const liveOpen = await call(FE, "POST", "/session/start");
  await sleep(2100);
  const liveStatus = await call(FE, "GET", "/me/status");
  const fb = liveStatus.body?.fixed_break;
  check("status reports today's fixed window",
    fb?.paid === false && fb.starts_at <= liveStatus.body.server_time && liveStatus.body.server_time < fb.ends_at,
    `(${JSON.stringify(fb)})`);
  check("a running unpaid window counts as break time on the open session",
    liveStatus.body?.open_session?.break_sec >= 2, `(${JSON.stringify(liveStatus.body?.open_session)})`);
  const fxLive = await call(FM, "GET", "/admin/live");
  check("live floor carries today's fixed window", fxLive.body?.fixed_break?.starts_at === fb?.starts_at);
  const liveStop = await call(FE, "POST", "/session/stop");
  check("stop clips a window that runs past it",
    liveStop.status === 200 && liveStop.body?.break_sec === liveStop.body?.duration_sec,
    `(break ${liveStop.body?.break_sec}, duration ${liveStop.body?.duration_sec}, session ${liveOpen.body?.id})`);
} else {
  console.log("  SKIP  live fixed-window checks (too close to local midnight)");
}
```

- [ ] **Step 2: Run to verify they fail**

Run the smoke command. Expected: the new fixed-window checks FAIL (`break_sec` 0, `fixed_break` undefined, stop `break_sec` 0 vs duration — or unclipped); all 76 earlier checks PASS.

- [ ] **Step 3: Materialize fixed windows**

Change the tz import at the top of `src/server.js` to:

```js
import { localZone, localDate, wallToUtc, fixedWindows } from "./tz.js";
```

Insert immediately **before** the `autoCloseStale` doc comment:

```js
/** Today's fixed break window (local date of `t`), or null when the mode isn't fixed. */
function todayFixedBreak(st, t) {
  if (st?.break_mode !== "fixed" || !st.break_start || !st.break_end) return null;
  const day = localDate(st.timezone, t);
  return {
    starts_at: wallToUtc(st.timezone, day, st.break_start),
    ends_at: wallToUtc(st.timezone, day, st.break_end),
    paid: Boolean(st.break_paid),
  };
}

/**
 * Unpaid fixed windows are written as `breaks` rows (kind 'fixed') once the window has
 * begun for a session, so every worked-time query deducts them like any other break and
 * a later policy change never rewrites a recorded day. Rows hold the whole window; reads
 * clip it to the session. INSERT IGNORE on ux_fixed_window makes this idempotent.
 */
async function recordFixedBreaks(session, st, t) {
  if (st?.break_mode !== "fixed" || st.break_paid || !st.break_start || !st.break_end) return;
  const start = Number(session.started_at);
  const until = session.ended_at == null ? t : Math.min(Number(session.ended_at), t);
  for (const [ws, we] of fixedWindows(st.timezone, start, until, st.break_start, st.break_end)) {
    if (ws > t || we <= start || ws >= until) continue;
    await q(
      `INSERT IGNORE INTO breaks (id, session_id, location_id, kind, started_at, ended_at)
       VALUES (:id, :sid, :loc, 'fixed', :ws, :we)`,
      { id: randomUUID(), sid: session.id, loc: session.location_id, ws, we }
    );
  }
}

/** Record started fixed windows for every open session (optionally one location). */
async function recordOpenFixedBreaks(loc = null) {
  const t = now();
  const open = await q(
    `SELECT s.id, s.location_id, s.started_at, s.ended_at,
            st.timezone, st.break_mode, st.break_start, st.break_end, st.break_paid
       FROM sessions s
       JOIN settings st ON st.location_id = s.location_id
      WHERE s.ended_at IS NULL AND st.break_mode = 'fixed' AND st.break_paid = 0
        AND (:loc IS NULL OR s.location_id = :loc)`,
    { loc }
  );
  for (const s of open) await recordFixedBreaks(s, s, t);
}
```

At the very start of `autoCloseStale`'s body (before the existing sessions UPDATE) add:

```js
  // Before any session is capped, so windows inside it are recorded first.
  await recordOpenFixedBreaks(loc);
```

- [ ] **Step 4: Clip the stop's break_sec to the session**

In `/session/stop`, replace

```js
    const [[brk]] = await conn.execute(
      "SELECT COALESCE(SUM(ended_at - started_at), 0) AS break_sec FROM breaks WHERE session_id = :id",
      { id: s.id }
    );
```

with

```js
    // Clipped to the session: a fixed window can run past the stop.
    const [[brk]] = await conn.execute(
      `SELECT COALESCE(SUM(GREATEST(0, LEAST(ended_at, :t) - GREATEST(started_at, :st))), 0) AS break_sec
         FROM breaks WHERE session_id = :id`,
      { id: s.id, t, st: s.started_at }
    );
```

- [ ] **Step 5: Manager edits record windows the new bounds cover**

In `PATCH /admin/sessions/:id`, replace

```js
    await conn.commit();
    return c.json({ id, started_at: s, ended_at: e, duration_sec: e - s, closed_by: "admin" });
```

with

```js
    await conn.commit();
    // The edited bounds may now cover a fixed window; record it under the current policy.
    await recordFixedBreaks({ id, location_id: loc, started_at: s, ended_at: e }, await getSettings(loc), now());
    return c.json({ id, started_at: s, ended_at: e, duration_sec: e - s, closed_by: "admin" });
```

- [ ] **Step 6: Expose today's window**

In `/me/status`, replace

```js
    worked_sec: Number(total[0].worked_sec),
    server_time: t,
  });
```

with

```js
    worked_sec: Number(total[0].worked_sec),
    fixed_break: todayFixedBreak(await getSettings(loc), t),
    server_time: t,
  });
```

In `/admin/live`, replace

```js
  return c.json({ server_time: now(), employees });
```

with

```js
  const t = now();
  return c.json({ server_time: t, fixed_break: todayFixedBreak(await getSettings(loc), t), employees });
```

- [ ] **Step 7: Restart and run the smoke test**

Run the restart command, then the smoke command.
Expected: **84 passed, 0 failed** (76 + 8), or **80 passed** plus one `SKIP` line in the last hour before Riyadh midnight. `npm run test:unit` stays at 12.

- [ ] **Step 8: Document in `PROJECT.md`**

§8: append to the `/me/status` row: `، و\`fixed_break: {starts_at, ends_at, paid} | null\` (نافذة اليوم إذا \`break_mode = fixed\`)`; append the same `fixed_break` note to `/admin/live`. §9 business rules: add a rule (Arabic, same style) — الاستراحة الثابتة غير المدفوعة بتنخصم من أي جلسة بتغطي النافذة، حتى لو الموظف اشتغل وقتها؛ بتنسجل كصف \`breaks\` نوعه \`fixed\` أول ما تبلش النافذة لجلسة مفتوحة أو لما المدير يعدّل جلسة لتغطيها، فتغيير الإعدادات بعدين ما بيغيّر الأيام المسجلة؛ المدفوعة ما بتنخصم وبتنعرض للموظف بس.

- [ ] **Step 9: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(breaks): record unpaid fixed windows and expose today's window"
```

---

### Task 4: Settings UI — break mode, window, paid

**Files:**
- Modify: `web/src/components/SettingsPanel.jsx`, `web/src/components/SettingsPanel.test.jsx`

**Interfaces:**
- Consumes (Task 2): `GET/PUT /admin/settings` with `break_mode`, `break_start`, `break_end`, `break_paid`; errors `INVALID_BREAK_MODE`, `INVALID_BREAK_WINDOW`.
- Produces: select labelled `نوع الاستراحة` (options `بدون` / `ثابتة (يحددها المدير)` / `مرنة (الموظف يضغط)` = `off` / `fixed` / `flexible`); when `fixed`: inputs labelled `بداية الاستراحة (HH:MM)`, `نهاية الاستراحة (HH:MM)` and checkbox `استراحة مدفوعة (تنحسب من الدوام)`.

- [ ] **Step 1: Replace the two phase-2 break tests**

In `web/src/components/SettingsPanel.test.jsx`, delete the tests `"shows the saved break and note policies"` and `"saves the break and note policies"`, and append inside the describe block:

```jsx
  const BASE = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15, note_on_stop: "off" };

  it("shows a saved fixed break with its window and pay", async () => {
    const api = {
      get: vi.fn(async () => ({ ...BASE, note_on_stop: "required", break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: true })),
      put: vi.fn(),
    };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نوع الاستراحة")).toHaveValue("fixed");
    expect(screen.getByLabelText("بداية الاستراحة (HH:MM)")).toHaveValue("13:00");
    expect(screen.getByLabelText("نهاية الاستراحة (HH:MM)")).toHaveValue("14:00");
    expect(screen.getByLabelText("استراحة مدفوعة (تنحسب من الدوام)")).toBeChecked();
    expect(screen.getByLabelText("ملاحظة عند إنهاء الدوام")).toHaveValue("required");
  });

  it("hides the window fields unless the mode is fixed", async () => {
    const api = { get: vi.fn(async () => ({ ...BASE, break_mode: "flexible", break_start: null, break_end: null, break_paid: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نوع الاستراحة")).toHaveValue("flexible");
    expect(screen.queryByLabelText("بداية الاستراحة (HH:MM)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("استراحة مدفوعة (تنحسب من الدوام)")).not.toBeInTheDocument();
  });

  it("saves a fixed unpaid window and the note policy", async () => {
    const saved = { ...BASE, break_mode: "off", break_start: null, break_end: null, break_paid: false };
    const api = { get: vi.fn(async () => saved), put: vi.fn(async (_p, body) => ({ ...saved, ...body })) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.change(await screen.findByLabelText("نوع الاستراحة"), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText("بداية الاستراحة (HH:MM)"), { target: { value: "13:00" } });
    fireEvent.change(screen.getByLabelText("نهاية الاستراحة (HH:MM)"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("ملاحظة عند إنهاء الدوام"), { target: { value: "optional" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toEqual(expect.objectContaining({
      break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false, note_on_stop: "optional",
    }));
    expect(api.put.mock.calls[0][1]).not.toHaveProperty("breaks_enabled");
  });

  it("explains an invalid break window", async () => {
    const api = {
      get: vi.fn(async () => ({ ...BASE, break_mode: "fixed", break_start: "14:00", break_end: "13:00", break_paid: false })),
      put: vi.fn(async () => { throw Object.assign(new Error("x"), { code: "INVALID_BREAK_WINDOW" }); }),
    };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText("وقت الاستراحة غير صحيح (البداية لازم تكون قبل النهاية)")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx vitest run src/components/SettingsPanel.test.jsx`
Expected: the 4 new tests FAIL (no `نوع الاستراحة` label); the 3 older tests PASS.

- [ ] **Step 3: Implement**

In `web/src/components/SettingsPanel.jsx`, in the PUT body replace

```js
        breaks_enabled: Boolean(s.breaks_enabled),
        note_on_stop: s.note_on_stop ?? "off",
```

with

```js
        break_mode: s.break_mode ?? "off",
        break_start: s.break_start || null,
        break_end: s.break_end || null,
        break_paid: Boolean(s.break_paid),
        note_on_stop: s.note_on_stop ?? "off",
```

In the error mapping replace

```js
        : e.code === "INVALID_BREAKS" ? "إعداد الاستراحات غير صحيح"
```

with

```js
        : e.code === "INVALID_BREAKS" ? "إعداد الاستراحات غير صحيح"
        : e.code === "INVALID_BREAK_MODE" ? "نوع الاستراحة غير صحيح"
        : e.code === "INVALID_BREAK_WINDOW" ? "وقت الاستراحة غير صحيح (البداية لازم تكون قبل النهاية)"
```

Replace the whole `<div className="field check">…تفعيل الاستراحات…</div>` block with:

```jsx
      <div className="field">
        <label htmlFor="break-mode">نوع الاستراحة</label>
        <select id="break-mode" value={s.break_mode ?? "off"} onChange={set("break_mode")}>
          <option value="off">بدون</option>
          <option value="fixed">ثابتة (يحددها المدير)</option>
          <option value="flexible">مرنة (الموظف يضغط)</option>
        </select>
      </div>
      {s.break_mode === "fixed" && (
        <>
          <div className="row2">
            <div className="field"><label htmlFor="break-start">بداية الاستراحة (HH:MM)</label><input id="break-start" value={s.break_start ?? ""} onChange={set("break_start")} /></div>
            <div className="field"><label htmlFor="break-end">نهاية الاستراحة (HH:MM)</label><input id="break-end" value={s.break_end ?? ""} onChange={set("break_end")} /></div>
          </div>
          <div className="field check">
            <label><input type="checkbox" checked={Boolean(s.break_paid)} onChange={(e) => setS({ ...s, break_paid: e.target.checked })} />استراحة مدفوعة (تنحسب من الدوام)</label>
          </div>
        </>
      )}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npx vitest run`
Expected: **82 passed** (80 − 2 removed + 4 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx
git commit -m "feat(settings-ui): choose break mode, fixed window and pay"
```

---

### Task 5: Employee screen and live floor — fixed window display and pause

**Files:**
- Modify: `web/src/time.js`, `web/src/time.test.js`, `web/src/components/EmployeeScreen.jsx`, `web/src/components/EmployeeScreen.test.jsx`, `web/src/components/LiveFloor.jsx`, `web/src/components/LiveFloor.test.jsx`

**Interfaces:**
- Consumes (Tasks 2–3): `GET /me/settings` → `break_mode`, `break_start`, `break_end`, `break_paid` (and legacy `breaks_enabled`); `GET /me/status` and `GET /admin/live` → `fixed_break: { starts_at, ends_at, paid } | null`.
- Produces: `liveTotals(status, nowS) → { sessionSec, todaySec, onBreak, inFixed }` in `web/src/time.js`.

- [ ] **Step 1: Write the failing tests**

In `web/src/time.test.js`, add `liveTotals` to the import from `"./time.js"` and append:

```js
describe("liveTotals", () => {
  const t = 1_000_000;
  const base = { open_session: { id: "s", started_at: t - 3600, break_sec: 0 }, open_break: null, worked_sec: 3600, server_time: t, fixed_break: null };

  it("adds only the seconds since server_time (no double count)", () => {
    expect(liveTotals(base, t + 60)).toMatchObject({ sessionSec: 3660, todaySec: 3660, onBreak: false, inFixed: false });
  });

  it("freezes during an employee break", () => {
    const s = { ...base, open_session: { ...base.open_session, break_sec: 600 }, open_break: { id: "b", started_at: t - 600 }, worked_sec: 3000 };
    expect(liveTotals(s, t + 900)).toMatchObject({ sessionSec: 3000, todaySec: 3000, onBreak: true });
  });

  it("pauses for the part of an unpaid fixed window after server_time", () => {
    const s = { ...base, fixed_break: { starts_at: t + 60, ends_at: t + 660, paid: false } };
    expect(liveTotals(s, t + 300)).toMatchObject({ todaySec: 3600 + 60, inFixed: true });
    expect(liveTotals(s, t + 900)).toMatchObject({ sessionSec: 3600 + 300, todaySec: 3600 + 300, inFixed: false });
  });

  it("keeps counting through a paid fixed window", () => {
    const s = { ...base, fixed_break: { starts_at: t + 60, ends_at: t + 660, paid: true } };
    expect(liveTotals(s, t + 300)).toMatchObject({ todaySec: 3900, inFixed: true });
  });

  it("is all zeros with no open session", () => {
    expect(liveTotals({ open_session: null, open_break: null, worked_sec: 120, server_time: t, fixed_break: null }, t + 50))
      .toMatchObject({ sessionSec: 0, todaySec: 120, inFixed: false });
  });
});
```

In `web/src/components/EmployeeScreen.test.jsx`, change `DEFAULT_SETTINGS` to

```jsx
const DEFAULT_SETTINGS = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null, break_mode: "off", break_start: null, break_end: null, break_paid: false, note_on_stop: "off" };
```

replace every `{ ...DEFAULT_SETTINGS, breaks_enabled: true }` in the file with `{ ...DEFAULT_SETTINGS, break_mode: "flexible" }`, and append inside the describe block:

```jsx
  it("shows a fixed window as break time without a break button", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 3600, break_sec: 300 }, open_break: null, worked_sec: 3300, server_time: t,
        fixed_break: { starts_at: t - 300, ends_at: t + 3300, paid: false } },
      { ...DEFAULT_SETTINGS, break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("وقت الاستراحة")).toBeInTheDocument();
    expect(await screen.findByText(/13:00–14:00/)).toBeInTheDocument();
    expect(screen.getByText(/غير مدفوعة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /استراحة/ })).not.toBeInTheDocument();
  });

  it("still honours the legacy breaks_enabled flag", async () => {
    const t = nowSec();
    const legacy = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null, breaks_enabled: true, note_on_stop: "off" };
    const api = makeApi({ open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t }, legacy);
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /^استراحة$/ })).toBeInTheDocument();
  });
```

In `web/src/components/LiveFloor.test.jsx`, append inside the describe block:

```jsx
  it("marks working people during today's fixed window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      fixed_break: { starts_at: now - 60, ends_at: now + 3540, paid: false },
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 3600, break_started_at: null }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("وقت الاستراحة")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx vitest run`
Expected: the 5 `liveTotals` tests, the 2 new EmployeeScreen tests and the LiveFloor test FAIL; everything else PASSES (the renamed flexible tests fail too until Step 3 — that is expected).

- [ ] **Step 3: Implement**

Append to `web/src/time.js`:

```js
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/**
 * Live session and day totals at client time `nowS` (server clock). The server's numbers
 * are exact at `server_time`; only the seconds since then are added — nothing during an
 * employee break, and nothing for the part of an unpaid fixed window after server_time.
 */
export function liveTotals(status, nowS) {
  const open = status?.open_session;
  const onBreak = Boolean(status?.open_break);
  const fb = status?.fixed_break;
  const inFixed = Boolean(open && fb && nowS >= fb.starts_at && nowS < fb.ends_at);
  let since = 0;
  if (open && !onBreak) {
    since = Math.max(0, nowS - status.server_time);
    if (fb && !fb.paid) since -= overlap(status.server_time, nowS, fb.starts_at, fb.ends_at);
  }
  return {
    sessionSec: open ? status.server_time - open.started_at - (open.break_sec ?? 0) + since : 0,
    todaySec: (status?.worked_sec ?? 0) + since,
    onBreak,
    inFixed,
  };
}
```

In `web/src/components/EmployeeScreen.jsx`:

- change the time import to `import { formatClock, formatHours, serverOffset, nowWithOffset, liveTotals } from "../time.js";`
- replace the policy state line with
  `const [policy, setPolicy] = useState({ break_mode: "off", break_start: null, break_end: null, break_paid: false, note_on_stop: "off" });`
- replace the `setPolicy({ breaks_enabled: …, note_on_stop: … })` call in the settings effect with:

```js
        setPolicy({
          // Older API responses only carry breaks_enabled.
          break_mode: cfg.break_mode ?? (cfg.breaks_enabled ? "flexible" : "off"),
          break_start: cfg.break_start ?? null,
          break_end: cfg.break_end ?? null,
          break_paid: Boolean(cfg.break_paid),
          note_on_stop: cfg.note_on_stop ?? "off",
        });
```

- replace the block from `const open = status?.open_session;` through `const showBreak = …;` with:

```js
  const open = status?.open_session;
  const { sessionSec, todaySec, onBreak, inFixed } = liveTotals(status, nowWithOffset(offsetRef.current));
  const clock = formatClock(sessionSec);
  const remain = Math.max(0, targetSec - todaySec);
  const pct = Math.min(100, (todaySec / targetSec) * 100);
  const name = user?.name || "";
  const [chipClass, chipText] = onBreak ? ["break", "في استراحة"]
    : inFixed ? ["break", "وقت الاستراحة"]
    : open ? ["work", "داخل الدوام"] : ["off", "لم يسجّل الدخول"];
  // An employee already on a break can always end it, even if the mode changed since.
  const showBreak = open && (policy.break_mode === "flexible" || onBreak);
```

- right after the closing `</div>` of the `goal` progressbar div, add:

```jsx
          {policy.break_mode === "fixed" && policy.break_start && policy.break_end && (
            <p className="hint">الاستراحة <span className="ltr">{policy.break_start}–{policy.break_end}</span> · {policy.break_paid ? "مدفوعة" : "غير مدفوعة"}</p>
          )}
```

In `web/src/components/LiveFloor.jsx`, inside the component before `const lane = …`, add:

```js
  const nowS = nowWithOffset(offsetRef.current);
  const fb = data.fixed_break;
  const inFixed = Boolean(fb && nowS >= fb.starts_at && nowS < fb.ends_at);
```

and replace

```jsx
            {live && (p.break_started_at
              ? <div className="m break">استراحة · {formatDuration(nowWithOffset(offsetRef.current) - p.break_started_at)}</div>
              : <div className="m">{formatDuration(nowWithOffset(offsetRef.current) - p.started_at)}</div>)}
```

with

```jsx
            {live && (p.break_started_at
              ? <div className="m break">استراحة · {formatDuration(nowS - p.break_started_at)}</div>
              : inFixed
                ? <div className="m break">وقت الاستراحة</div>
                : <div className="m">{formatDuration(nowS - p.started_at)}</div>)}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npx vitest run`
Expected: **90 passed** (82 + 5 liveTotals + 2 employee + 1 live floor).

- [ ] **Step 5: Commit**

```bash
git add web/src/time.js web/src/time.test.js web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx web/src/components/LiveFloor.jsx web/src/components/LiveFloor.test.jsx
git commit -m "feat(employee): show and pause for a fixed break window"
```

---

## After all tasks (controller)

1. Full verification: unit 12, frontend 90, smoke 84 (0 failed), `npm run build`.
2. `docs/PROGRESS.md` + `docs/DECISIONS.md` (fixed windows materialized as `breaks` rows so history is frozen; unpaid deducted even if worked through; `breaks_enabled` kept in sync for old code; legacy body mapping).
3. **Production migration first:** the user runs `migrations/003_break_modes.sql` in phpMyAdmin, confirms with `SHOW COLUMNS FROM settings LIKE 'break_%'; SHOW COLUMNS FROM breaks LIKE 'kind';`, then record the date in `migrations/README.md`.
4. Only then push `main` and verify inside GHL.
