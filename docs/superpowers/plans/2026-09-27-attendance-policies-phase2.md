# Attendance Policies — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager switch on breaks (pause counting without ending the session) and a note on stop (off / optional / required), and show both to the manager in the session detail, live floor and CSV.

**Architecture:** One migration (two settings columns, `sessions.note`, a new `breaks` table whose `open_flag` enforces one open break per session in the database). Worked time stays computed on read: every SQL that sums worked seconds subtracts that session's breaks, clipped to the session and to the query window, so manager edits and window edges never over-count. `duration_sec` keeps its current meaning (wall-clock length); `break_sec` is returned beside it and worked = `duration_sec − break_sec`. Frontend adds a break button, a stop-note dialog, two settings controls, and two detail columns.

**Tech Stack:** Node 20 ESM · Hono 4 · mysql2 (named placeholders, `decimalNumbers: true`) · React 18 · Vite 5 · Vitest 2 + React Testing Library · MariaDB 11 locally (Docker `timeclock-db`), MariaDB on Hostinger in production

**Spec:** `docs/superpowers/specs/2026-09-24-attendance-policies-design.md` (§4, §5.4, §5.5, §6 phase 2, §7 phase 2)

## Global Constraints

- Plain ESM JavaScript, 2-space indent, semicolons. No TypeScript, no backend build step.
- SQL must run on **both MySQL 8 and MariaDB 10.2+**. Do not use partial indexes, `UPDATE ... RETURNING`, `INSERT ... AS alias ON DUPLICATE KEY`, or `ADD COLUMN IF NOT EXISTS`.
- `location_id` and `user_id` come **only** from `c.get("claims")`, never from the request body or query.
- Every `/admin/*` route uses `authed, managerOnly`.
- Errors are `{ error: "CODE" }` via `throw new HttpError(status, "CODE")`; every new code is documented in `PROJECT.md` §8 (رموز الأخطاء table).
- All timestamps are UNIX seconds (UTC).
- UI is Arabic, RTL, Western digits only. Token stays in memory. Live timers use `server_time`, never the client clock alone.
- **Migration order is mandatory: database first, then code** (spec §6). Deploys do not migrate; after this phase every worked-time query reads `breaks`, so code on an unmigrated DB returns 500 on `/me/status` and `/admin/report`.
- Never commit secrets or `.env`.
- Settings defaults (spec §4): `breaks_enabled` = `false`, `note_on_stop` = `'off'`. Note max length 500 (spec §6 `VARCHAR(500)`).

## Shared commands (used by every backend task)

Restart the local API after changing `src/server.js`:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
pkill -f "node --env-file=.env src/server.js"; nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health >/dev/null; do sleep 1; done; echo up
```

Run the backend smoke test (needs Docker `timeclock-db` running and the API up):

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke 2>&1 | grep -E "FAIL|passed"
```

Run frontend tests: `cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run`

Baseline before Task 1: smoke **41 passed, 0 failed**; frontend **56 passed**; `npm run test:unit` **8 passed**.

## File map

| File | Change |
|---|---|
| `migrations/002_breaks_and_notes.sql` | new — phase 2 DDL |
| `migrations/README.md` | add 002 row (pending) |
| `schema.sql` | add the new columns + `breaks` table (fresh installs) |
| `src/server.js` | settings (T1), breaks + worked math (T2), note on stop + CSV (T3) |
| `scripts/smoke-test.mjs` | phase-2 fixture block (T1), break checks (T2), note checks (T3) |
| `PROJECT.md` | §8 API + error codes (T1–T3) |
| `web/src/components/SettingsPanel.jsx` (+test) | break toggle + note policy select (T4) |
| `web/src/components/StopNoteDialog.jsx` (+test) | new dialog (T5) |
| `web/src/components/EmployeeScreen.jsx` (+test) | break button, note flow, timer math (T5) |
| `web/src/components/Icon.jsx` | `pause` icon (T5) |
| `web/src/styles.css` | `.overlay`, `.field.check`, `td.note`, `.person .m.break` (T4–T6) |
| `web/src/time.js` (+test) | `formatBreak` (T6) |
| `web/src/components/ReportPanel.jsx` (+test) | break + note columns (T6) |
| `web/src/components/LiveFloor.jsx` (+test) | on-break state (T6) |
| `web/src/components/MyHistory.jsx` (+test) | hours exclude breaks (T6) |

---

### Task 1: Migration 002 + phase-2 settings API

**Files:**
- Create: `migrations/002_breaks_and_notes.sql`
- Modify: `migrations/README.md`, `schema.sql`, `src/server.js` (`getSettings`, `GET /me/settings`, `PUT /admin/settings`), `scripts/smoke-test.mjs` (`cleanupLocation`, new phase-2 block), `PROJECT.md` §8

**Interfaces:**
- Produces: `settings.breaks_enabled` (API: boolean), `settings.note_on_stop` (`"off" | "optional" | "required"`) on `GET/PUT /admin/settings` and `GET /me/settings`. Error codes `INVALID_BREAKS` (400), `INVALID_NOTE_POLICY` (400). Tables `breaks`, column `sessions.note`. Smoke-test fixture constants `P2LOC`, `PM` (manager token), `PE` (employee token), `p2Policy(breaks_enabled, note_on_stop)` and the line `await cleanupLocation(P2LOC);` that later tasks insert before.

- [ ] **Step 1: Write the migration file**

Create `migrations/002_breaks_and_notes.sql`:

```sql
-- 002 · Attendance policies phase 2: breaks and note on stop.
-- Apply BEFORE deploying the phase 2 code: every worked-time query reads `breaks`,
-- so the new code on an unmigrated database returns 500 on /me/status and /admin/report.
-- schema.sql already includes all of this; run this only on an existing database.
-- Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN breaks_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER late_grace_minutes;
ALTER TABLE settings
  ADD COLUMN note_on_stop ENUM('off','optional','required') NOT NULL DEFAULT 'off' AFTER breaks_enabled;
ALTER TABLE sessions
  ADD COLUMN note VARCHAR(500) NULL AFTER closed_by;

CREATE TABLE IF NOT EXISTS breaks (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  session_id  CHAR(36)    NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  started_at  BIGINT      NOT NULL,
  ended_at    BIGINT      NULL,
  -- 1 while the break is open, NULL once ended: UNIQUE allows many NULLs, so the
  -- database itself enforces "one open break per session" (same trick as sessions).
  open_flag   TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  UNIQUE KEY ux_one_open_break (session_id, open_flag),
  KEY ix_breaks_session (session_id),
  KEY ix_breaks_loc (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: Mirror it in `schema.sql` and the migrations log**

In `schema.sql`, inside `CREATE TABLE IF NOT EXISTS settings`, replace

```sql
  late_grace_minutes INT          NOT NULL DEFAULT 15,
```

with

```sql
  late_grace_minutes INT          NOT NULL DEFAULT 15,
  breaks_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  note_on_stop       ENUM('off','optional','required') NOT NULL DEFAULT 'off',
```

Inside `CREATE TABLE IF NOT EXISTS sessions`, replace

```sql
  closed_by    ENUM('user','auto','admin') NULL,
```

with

```sql
  closed_by    ENUM('user','auto','admin') NULL,
  note         VARCHAR(500) NULL,
```

Append at the end of `schema.sql`:

```sql

CREATE TABLE IF NOT EXISTS breaks (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  session_id  CHAR(36)    NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  started_at  BIGINT      NOT NULL,
  ended_at    BIGINT      NULL,
  -- 1 while the break is open, NULL once ended → one open break per session.
  open_flag   TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  UNIQUE KEY ux_one_open_break (session_id, open_flag),
  KEY ix_breaks_session (session_id),
  KEY ix_breaks_loc (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

In `migrations/README.md`, append a row to the `## Applied` table:

```markdown
| `002_breaks_and_notes.sql` | pending | apply before deploying phase 2 |
```

- [ ] **Step 3: Apply the migration to the local database**

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
set -a; . ./.env; set +a
docker exec -i timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/002_breaks_and_notes.sql
docker exec timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "SHOW COLUMNS FROM settings LIKE 'note_on_stop'; SHOW TABLES LIKE 'breaks';"
```

Expected: one `note_on_stop` row with type `enum('off','optional','required')`, and `breaks` listed. (If `docker ps` shows no `timeclock-db`, run `open -a Docker`, wait for `docker info` to succeed, then `docker start timeclock-db`.)

- [ ] **Step 4: Let the smoke test clean up breaks, then write the failing settings checks**

In `scripts/smoke-test.mjs`, in `cleanupLocation`, replace

```js
    for (const table of ["edits_log", "sessions", "employees", "settings"]) {
```

with

```js
    for (const table of ["breaks", "edits_log", "sessions", "employees", "settings"]) {
```

Then find the DST block's last line, `await cleanupLocation(DSTLOC);`, and insert immediately **after** it:

```js

// --- Phase 2: breaks and note on stop. Runs on its own location so the policies it
// --- switches on cannot leak into the checks above; its rows are removed at the end.
const P2LOC = `${LOC}-p2`;
const p2Mgr = await sso({ userId: `${P2LOC}-m1`, role: "admin", type: "account", activeLocation: P2LOC, userName: "مدير المرحلة 2", email: "pm@x.com" });
const p2Emp = await sso({ userId: `${P2LOC}-u1`, role: "user", type: "account", activeLocation: P2LOC, userName: "موظف المرحلة 2", email: "pe@x.com" });
const PM = p2Mgr.body?.token, PE = p2Emp.body?.token;
const p2Base = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: null, late_grace_minutes: 15 };
const p2Policy = (breaks_enabled, note_on_stop) =>
  call(PM, "PUT", "/admin/settings", { ...p2Base, breaks_enabled, note_on_stop });

const p2Defaults = await call(PM, "GET", "/admin/settings");
check("phase 2 settings default to off",
  p2Defaults.body?.breaks_enabled === false && p2Defaults.body?.note_on_stop === "off",
  `(${JSON.stringify({ b: p2Defaults.body?.breaks_enabled, n: p2Defaults.body?.note_on_stop })})`);
const p2Saved = await p2Policy(true, "optional");
check("phase 2 settings saved",
  p2Saved.status === 200 && p2Saved.body?.breaks_enabled === true && p2Saved.body?.note_on_stop === "optional",
  `(status ${p2Saved.status}, ${JSON.stringify(p2Saved.body)})`);
check("invalid note policy → 400", (await p2Policy(true, "sometimes")).body?.error === "INVALID_NOTE_POLICY");
check("non-boolean breaks_enabled → 400", (await p2Policy("yes", "off")).body?.error === "INVALID_BREAKS");
const p2Me = await call(PE, "GET", "/me/settings");
check("employee sees the break and note policy",
  p2Me.body?.breaks_enabled === true && p2Me.body?.note_on_stop === "optional",
  `(${JSON.stringify(p2Me.body)})`);

await cleanupLocation(P2LOC);
```

- [ ] **Step 5: Run the smoke test to verify the new checks fail**

Run the smoke command (see *Shared commands*; the API is still the old code).
Expected: the 5 new checks FAIL (`breaks_enabled` is `0`/`undefined`, invalid values are accepted), all others PASS.

- [ ] **Step 6: Implement settings in `src/server.js`**

Replace `getSettings`:

```js
async function getSettings(loc) {
  const rows = await q("SELECT * FROM settings WHERE location_id = :loc", { loc });
  const st = rows[0];
  // TINYINT(1) arrives as 0/1; the API speaks booleans.
  return st ? { ...st, breaks_enabled: Boolean(st.breaks_enabled) } : null;
}

const NOTE_POLICIES = ["off", "optional", "required"];
```

In `GET /me/settings`, replace

```js
    work_start: st?.work_start ?? null,
  });
```

with

```js
    work_start: st?.work_start ?? null,
    breaks_enabled: Boolean(st?.breaks_enabled),
    note_on_stop: st?.note_on_stop ?? "off",
  });
```

In `PUT /admin/settings`, replace

```js
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new HttpError(400, "INVALID_GRACE");

  await q(
    `UPDATE settings SET timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         late_grace_minutes = :grace, max_session_hours = :max, updated_at = :t
      WHERE location_id = :loc`,
    { tz: b.timezone, target, ws: b.work_start ?? null, grace, max, t: now(), loc }
  );
```

with

```js
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new HttpError(400, "INVALID_GRACE");
  // PUT replaces the whole policy: an omitted field means the default, not "unchanged".
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

- [ ] **Step 7: Restart the API and run the smoke test**

Run the restart command, then the smoke command.
Expected: **46 passed, 0 failed**.

- [ ] **Step 8: Document the API in `PROJECT.md` §8**

In the manager table, replace the `PUT /admin/settings` row with:

```markdown
| PUT | `/admin/settings` | Body: `{ timezone, daily_target_hours, max_session_hours, work_start, late_grace_minutes, breaks_enabled, note_on_stop }` — `breaks_enabled` boolean (افتراضي `false`)، `note_on_stop` واحد من `off`/`optional`/`required` (افتراضي `off`). الحقل الناقص = القيمة الافتراضية |
```

Append to the رموز الأخطاء table:

```markdown
| `INVALID_BREAKS` | 400 | `breaks_enabled` مش boolean | إعداد الاستراحات غير صحيح |
| `INVALID_NOTE_POLICY` | 400 | `note_on_stop` مش من القيم المسموحة | إعداد الملاحظة غير صحيح |
```

- [ ] **Step 9: Commit**

```bash
git add migrations schema.sql src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(settings): add break and note-on-stop policies (migration 002)"
```

---

### Task 2: Breaks — endpoints and worked time that excludes them

**Files:**
- Modify: `src/server.js` (shared SQL, `autoCloseStale`, `/me/status`, `/me/sessions`, `/session/stop`, new `/session/break/start` + `/session/break/stop`, `/admin/live`, `/admin/sessions`), `scripts/smoke-test.mjs` (phase-2 block), `PROJECT.md` §8

**Interfaces:**
- Consumes (Task 1): `breaks` table; `getSettings(loc).breaks_enabled` (boolean); smoke `P2LOC`, `PM`, `PE`, `p2Policy`, `sleep`.
- Produces:
  - `POST /session/break/start` → `201 { id, session_id, started_at }` · `403 BREAKS_DISABLED` · `409 NO_OPEN_SESSION` · `409 BREAK_ALREADY_OPEN`
  - `POST /session/break/stop` → `200 { id, started_at, ended_at, duration_sec }` · `409 NO_OPEN_BREAK`
  - `POST /session/stop` → adds `break_sec` (number) to its response; ends an open break at the same instant.
  - `GET /me/status` → `open_session: { id, started_at, break_sec } | null` (break_sec = break seconds so far, including a running break up to `server_time`), new `open_break: { id, started_at } | null`; `worked_sec` excludes breaks.
  - `GET /admin/live` → each employee gains `break_started_at` (number | null).
  - `GET /me/sessions`, `GET /admin/sessions` → each session gains `break_sec` (number).
  - `GET /admin/report` → `worked_sec` excludes breaks.
  - SQL constants `BREAK_SEC_EXPR` (needs `:now`, table alias `s`) and the new `WORKED_EXPR` (needs `:now`, `:from`, `:to`, alias `s`).

- [ ] **Step 1: Write the failing break checks**

In `scripts/smoke-test.mjs`, insert immediately **before** the line `await cleanupLocation(P2LOC);`:

```js
// Breaks. A disabled policy refuses a break outright.
await p2Policy(false, "off");
await call(PE, "POST", "/session/start");
check("break while breaks are disabled → 403",
  (await call(PE, "POST", "/session/break/start")).body?.error === "BREAKS_DISABLED");
await call(PE, "POST", "/session/stop");
await p2Policy(true, "off");
check("break without an open session → 409",
  (await call(PE, "POST", "/session/break/start")).body?.error === "NO_OPEN_SESSION");

const p2Open = await call(PE, "POST", "/session/start");
const b1 = await call(PE, "POST", "/session/break/start");
check("break starts on the open session",
  b1.status === 201 && b1.body?.session_id === p2Open.body?.id, `(status ${b1.status})`);
check("a second open break → 409",
  (await call(PE, "POST", "/session/break/start")).body?.error === "BREAK_ALREADY_OPEN");
const onBreak = await call(PE, "GET", "/me/status");
check("status reports the open break", onBreak.body?.open_break?.id === b1.body?.id,
  `(${JSON.stringify(onBreak.body?.open_break)})`);
const p2Live = await call(PM, "GET", "/admin/live");
check("live floor shows who is on a break",
  p2Live.body?.employees?.find((e) => e.user_id === `${P2LOC}-u1`)?.break_started_at === b1.body?.started_at);
await sleep(2100);
const b1Stop = await call(PE, "POST", "/session/break/stop");
check("break stops", b1Stop.status === 200 && b1Stop.body?.duration_sec >= 2,
  `(status ${b1Stop.status}, ${JSON.stringify(b1Stop.body)})`);
check("stopping with no open break → 409",
  (await call(PE, "POST", "/session/break/stop")).body?.error === "NO_OPEN_BREAK");
const afterBreak = await call(PE, "GET", "/me/status");
check("status carries the closed break time of the open session",
  afterBreak.body?.open_break === null && afterBreak.body?.open_session?.break_sec === b1Stop.body?.duration_sec,
  `(${JSON.stringify(afterBreak.body?.open_session)})`);

// Stopping during a second break ends that break at the same instant.
const b2 = await call(PE, "POST", "/session/break/start");
await sleep(1100);
const p2Stop = await call(PE, "POST", "/session/stop");
const expectedBreak = b1Stop.body?.duration_sec + (p2Stop.body?.ended_at - b2.body?.started_at);
check("stop during a break ends the break with the session",
  p2Stop.status === 200 && p2Stop.body?.break_sec === expectedBreak,
  `(break_sec ${JSON.stringify(p2Stop.body?.break_sec)}, expected ${expectedBreak})`);

const p2From = p2Open.body?.started_at, p2To = p2Stop.body?.ended_at + 10;
const p2Rows = await call(PM, "GET", `/admin/sessions?from=${p2From}&to=${p2To}&user_id=${P2LOC}-u1`);
check("session detail carries break_sec",
  p2Rows.body?.sessions?.find((x) => x.id === p2Open.body?.id)?.break_sec === p2Stop.body?.break_sec);
const p2Mine = await call(PE, "GET", "/me/sessions?days=1");
check("employee history carries break_sec",
  p2Mine.body?.sessions?.find((x) => x.id === p2Open.body?.id)?.break_sec === p2Stop.body?.break_sec);
const p2Report = await call(PM, "GET", `/admin/report?from=${p2From}&to=${p2To}`);
const p2Worked = p2Report.body?.employees?.find((e) => e.user_id === `${P2LOC}-u1`)?.worked_sec;
check("report worked time excludes breaks",
  p2Worked === p2Stop.body?.duration_sec - p2Stop.body?.break_sec,
  `(worked ${p2Worked}, duration ${p2Stop.body?.duration_sec}, break ${p2Stop.body?.break_sec})`);
```

(The report window starts exactly at `p2Open.started_at`, so the zero-length session from the "disabled" check is clipped to 0 and cannot disturb the equality.)

- [ ] **Step 2: Run the smoke test to verify the new checks fail**

Run the smoke command. Expected: the 13 new break checks FAIL (404s on the break routes, missing fields); all 46 earlier checks PASS.

- [ ] **Step 3: Replace the shared worked-time SQL**

In `src/server.js`, replace

```js
// Seconds worked inside [from, to), clipping sessions that cross the window edges.
const WORKED_EXPR = "GREATEST(0, LEAST(COALESCE(s.ended_at, :now), :to) - GREATEST(s.started_at, :from))";
```

with

```js
// Break seconds inside session `s`, each break clipped to the session's own bounds so a
// manager edit that shortens a session never leaves more break than duration.
// A running break counts up to :now.
const BREAK_SEC_EXPR = `(SELECT COALESCE(SUM(GREATEST(0,
      LEAST(COALESCE(b.ended_at, :now), COALESCE(s.ended_at, :now))
      - GREATEST(b.started_at, s.started_at))), 0)
    FROM breaks b WHERE b.session_id = s.id)`;

// Seconds worked inside [from, to): the session clipped to the window, minus its breaks
// clipped to the same window and to the session. duration_sec stays wall-clock length;
// worked time is always derived here, never stored.
const WORKED_EXPR = `GREATEST(0,
    LEAST(COALESCE(s.ended_at, :now), :to) - GREATEST(s.started_at, :from)
    - (SELECT COALESCE(SUM(GREATEST(0,
          LEAST(COALESCE(b.ended_at, :now), COALESCE(s.ended_at, :now), :to)
          - GREATEST(b.started_at, s.started_at, :from))), 0)
         FROM breaks b WHERE b.session_id = s.id))`;
```

- [ ] **Step 4: Close breaks left open by a session that closed without them**

In `autoCloseStale`, after the existing `await q(...)` UPDATE (still inside the function), add:

```js
  // A session closed while on a break (auto-close above, or a manager edit that set its
  // end) leaves that break open; end it at the session's end so it never dangles.
  await q(
    `UPDATE breaks b
       JOIN sessions s ON s.id = b.session_id
        SET b.ended_at = GREATEST(b.started_at, s.ended_at)
      WHERE b.ended_at IS NULL AND s.ended_at IS NOT NULL
        AND (:loc IS NULL OR b.location_id = :loc)`,
    { loc }
  );
```

- [ ] **Step 5: `/me/status` reports the break state**

Replace the body of `app.get("/me/status", ...)` from `const open = await q(` down to its `return c.json(...)` with:

```js
  const open = await q(
    `SELECT s.id, s.started_at, ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
      WHERE s.user_id = :uid AND s.location_id = :loc AND s.ended_at IS NULL`,
    { uid, loc, now: t }
  );
  const brk = open.length
    ? await q("SELECT id, started_at FROM breaks WHERE session_id = :sid AND ended_at IS NULL", { sid: open[0].id })
    : [];
  const total = await q(
    `SELECT COALESCE(SUM(${WORKED_EXPR}), 0) AS worked_sec
       FROM sessions s
      WHERE s.user_id = :uid AND s.location_id = :loc
        AND s.started_at < :to AND (s.ended_at IS NULL OR s.ended_at > :from)`,
    { now: t, to: t, from, uid, loc }
  );
  return c.json({
    open_session: open[0]
      ? { id: open[0].id, started_at: Number(open[0].started_at), break_sec: Number(open[0].break_sec) }
      : null,
    open_break: brk[0] ? { id: brk[0].id, started_at: Number(brk[0].started_at) } : null,
    worked_sec: Number(total[0].worked_sec),
    server_time: t,
  });
```

- [ ] **Step 6: `/me/sessions` returns break_sec**

Replace

```js
  const sessions = await q(
    `SELECT id, started_at, ended_at, duration_sec, closed_by
       FROM sessions
      WHERE user_id = :uid AND location_id = :loc AND started_at >= :from
      ORDER BY started_at DESC
      LIMIT 100`,
    { uid, loc, from }
  );
```

with

```js
  const sessions = (await q(
    `SELECT s.id, s.started_at, s.ended_at, s.duration_sec, s.closed_by, ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
      WHERE s.user_id = :uid AND s.location_id = :loc AND s.started_at >= :from
      ORDER BY s.started_at DESC
      LIMIT 100`,
    { uid, loc, from, now: now() }
  )).map((r) => ({ ...r, break_sec: Number(r.break_sec) }));
```

- [ ] **Step 7: Break endpoints, and stop ends a running break**

Insert after the whole `app.post("/session/start", ...)` handler:

```js
app.post("/session/break/start", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  if (!(await getSettings(loc))?.breaks_enabled) throw new HttpError(403, "BREAKS_DISABLED");
  const [s] = await q(
    "SELECT id FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL",
    { uid, loc }
  );
  if (!s) throw new HttpError(409, "NO_OPEN_SESSION");
  const id = randomUUID();
  const t = now();
  try {
    await q(
      "INSERT INTO breaks (id, session_id, location_id, started_at) VALUES (:id, :sid, :loc, :t)",
      { id, sid: s.id, loc, t }
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "BREAK_ALREADY_OPEN");
    throw e;
  }
  return c.json({ id, session_id: s.id, started_at: t }, 201);
});

app.post("/session/break/stop", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  // Ending a break is allowed even if the manager disabled breaks meanwhile —
  // otherwise the employee would be stuck on a break that can never end.
  const [b] = await q(
    `SELECT b.id, b.started_at
       FROM breaks b
       JOIN sessions s ON s.id = b.session_id
      WHERE s.user_id = :uid AND s.location_id = :loc AND s.ended_at IS NULL AND b.ended_at IS NULL`,
    { uid, loc }
  );
  if (!b) throw new HttpError(409, "NO_OPEN_BREAK");
  const t = now();
  const started = Number(b.started_at);
  await q("UPDATE breaks SET ended_at = :t WHERE id = :id AND ended_at IS NULL", { t, id: b.id });
  return c.json({ id: b.id, started_at: started, ended_at: t, duration_sec: t - started });
});
```

In `app.post("/session/stop", ...)`, replace

```js
    await conn.execute(
      "UPDATE sessions SET ended_at = :t, duration_sec = :dur, closed_by = 'user' WHERE id = :id",
      { t, dur: t - s.started_at, id: s.id }
    );
    await conn.commit();
    return c.json({ id: s.id, started_at: s.started_at, ended_at: t, duration_sec: t - s.started_at });
```

with

```js
    await conn.execute(
      "UPDATE sessions SET ended_at = :t, duration_sec = :dur, closed_by = 'user' WHERE id = :id",
      { t, dur: t - s.started_at, id: s.id }
    );
    // Stopping during a break ends the break at the same instant.
    await conn.execute(
      "UPDATE breaks SET ended_at = :t WHERE session_id = :id AND ended_at IS NULL",
      { t, id: s.id }
    );
    const [[brk]] = await conn.execute(
      "SELECT COALESCE(SUM(ended_at - started_at), 0) AS break_sec FROM breaks WHERE session_id = :id",
      { id: s.id }
    );
    await conn.commit();
    return c.json({
      id: s.id, started_at: s.started_at, ended_at: t,
      duration_sec: t - s.started_at, break_sec: Number(brk.break_sec),
    });
```

- [ ] **Step 8: Manager reads — live floor and session detail**

In `app.get("/admin/live", ...)`, replace

```js
    `SELECT e.user_id, e.name, e.email, s.id AS session_id, s.started_at
       FROM employees e
       LEFT JOIN sessions s ON s.user_id = e.user_id AND s.location_id = e.location_id AND s.ended_at IS NULL
```

with

```js
    `SELECT e.user_id, e.name, e.email, s.id AS session_id, s.started_at, b.started_at AS break_started_at
       FROM employees e
       LEFT JOIN sessions s ON s.user_id = e.user_id AND s.location_id = e.location_id AND s.ended_at IS NULL
       LEFT JOIN breaks b ON b.session_id = s.id AND b.ended_at IS NULL
```

In `app.get("/admin/sessions", ...)`, replace

```js
  const sessions = await q(
    `SELECT s.id, s.user_id, e.name, s.started_at, s.ended_at, s.duration_sec, s.closed_by
       FROM sessions s
       JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = :loc AND s.started_at >= :from AND s.started_at < :to
        AND (:uid IS NULL OR s.user_id = :uid)
      ORDER BY s.started_at DESC
      LIMIT 1000`,
    { loc, from, to, uid }
  );
```

with

```js
  const sessions = (await q(
    `SELECT s.id, s.user_id, e.name, s.started_at, s.ended_at, s.duration_sec, s.closed_by,
            ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
       JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = :loc AND s.started_at >= :from AND s.started_at < :to
        AND (:uid IS NULL OR s.user_id = :uid)
      ORDER BY s.started_at DESC
      LIMIT 1000`,
    { loc, from, to, uid, now: now() }
  )).map((r) => ({ ...r, break_sec: Number(r.break_sec) }));
```

- [ ] **Step 9: Restart the API and run the smoke test**

Run the restart command, then the smoke command.
Expected: **59 passed, 0 failed** (46 + 13). The earlier report/lateness/DST checks must still pass — they now run through the new `WORKED_EXPR`.

- [ ] **Step 10: Document in `PROJECT.md` §8**

In the الموظف table replace the `/me/status` and `/session/stop` rows and add the break rows:

```markdown
| GET | `/me/status?since=` | `{ open_session: {id, started_at, break_sec} \| null, open_break: {id, started_at} \| null, worked_sec, server_time }`. `worked_sec` بدون الاستراحات. `since` افتراضياً آخر 24 ساعة. |
| POST | `/session/stop` | `200 { id, started_at, ended_at, duration_sec, break_sec }` — `duration_sec` المدة الكاملة، ووقت العمل = `duration_sec − break_sec`. إذا في استراحة مفتوحة بتسكّر معها · `409 NO_OPEN_SESSION` |
| POST | `/session/break/start` | `201 { id, session_id, started_at }` · `403 BREAKS_DISABLED` · `409 NO_OPEN_SESSION` · `409 BREAK_ALREADY_OPEN` |
| POST | `/session/break/stop` | `200 { id, started_at, ended_at, duration_sec }` · `409 NO_OPEN_BREAK` — مسموح حتى لو المدير لغى الاستراحات |
```

In the manager table, append to the `/admin/live` description: `، ومع كل موظف \`break_started_at\` إذا هو باستراحة`; append to `/admin/sessions`: `، مع \`break_sec\` لكل جلسة`.

Append to رموز الأخطاء:

```markdown
| `BREAKS_DISABLED` | 403 | المدير ما فعّل الاستراحات | الاستراحات غير مفعّلة |
| `BREAK_ALREADY_OPEN` | 409 | | أنت في استراحة بالفعل |
| `NO_OPEN_BREAK` | 409 | | لا توجد استراحة مفتوحة |
```

- [ ] **Step 11: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(breaks): pause counting with breaks; worked time excludes them"
```

---

### Task 3: Note on stop — policy enforcement, detail and CSV

**Files:**
- Modify: `src/server.js` (`/session/stop`, `/admin/sessions`, `/admin/export.csv`), `scripts/smoke-test.mjs` (phase-2 block), `PROJECT.md` §8

**Interfaces:**
- Consumes (Tasks 1–2): `getSettings(loc).note_on_stop`, `BREAK_SEC_EXPR`, the Task-2 `/session/stop` handler, smoke `p2Policy`, `PE`, `PM`, `P2LOC`.
- Produces:
  - `POST /session/stop` accepts optional body `{ note: string }`; response adds `note` (string | null). Errors `400 NOTE_TOO_LONG` (> 500 chars after trim), `400 NOTE_REQUIRED` (policy `required` and empty note; the session stays open).
  - `GET /admin/sessions` → each session gains `note` (string | null).
  - `GET /admin/export.csv` → columns `Employee, Email, Start, End, Hours, Break (min), Closed by, Note`; `Hours` is worked time (breaks excluded); every cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`.

- [ ] **Step 1: Write the failing note checks**

In `scripts/smoke-test.mjs`, insert immediately **before** `await cleanupLocation(P2LOC);`:

```js
// Note on stop. A required note is enforced by the server, not just the UI.
await p2Policy(true, "required");
const p3Open = await call(PE, "POST", "/session/start");
check("stop without a required note → 400",
  (await call(PE, "POST", "/session/stop")).body?.error === "NOTE_REQUIRED");
check("the session stays open after a rejected stop",
  (await call(PE, "GET", "/me/status")).body?.open_session?.id === p3Open.body?.id);
check("note over 500 characters → 400",
  (await call(PE, "POST", "/session/stop", { note: "x".repeat(501) })).body?.error === "NOTE_TOO_LONG");
const noted = await call(PE, "POST", "/session/stop", { note: "  =أنهيت عرض السعر  " });
check("stop with a note → 200 and the note is trimmed",
  noted.status === 200 && noted.body?.note === "=أنهيت عرض السعر", `(${JSON.stringify(noted.body)})`);
const p3Rows = await call(PM, "GET", `/admin/sessions?from=${p3Open.body?.started_at}&to=${noted.body?.ended_at + 10}&user_id=${P2LOC}-u1`);
check("session detail carries the note",
  p3Rows.body?.sessions?.find((x) => x.id === p3Open.body?.id)?.note === "=أنهيت عرض السعر");
const p3Csv = await call(PM, "GET", `/admin/export.csv?from=${p3Open.body?.started_at}&to=${noted.body?.ended_at + 10}`);
check("CSV has break and note columns, and neutralises a formula-looking note",
  typeof p3Csv.body === "string" && p3Csv.body.includes('"Break (min)"') && p3Csv.body.includes('"Note"')
    && p3Csv.body.includes(`"'=أنهيت عرض السعر"`),
  `(${String(p3Csv.body).slice(0, 300)})`);

// With the policy off the note is not collected, so nothing is stored.
await p2Policy(true, "off");
await call(PE, "POST", "/session/start");
const unnoted = await call(PE, "POST", "/session/stop", { note: "لن تُحفظ" });
check("note is ignored when the policy is off", unnoted.status === 200 && unnoted.body?.note === null,
  `(${JSON.stringify(unnoted.body)})`);
```

- [ ] **Step 2: Run the smoke test to verify the new checks fail**

Run the smoke command. Expected: the 7 new checks FAIL; the 59 earlier checks PASS.

- [ ] **Step 3: Enforce the policy in `/session/stop`**

Replace the whole `app.post("/session/stop", ...)` handler with:

```js
const NOTE_MAX = 500;

app.post("/session/stop", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const body = await c.req.json().catch(() => ({}));
  const rawNote = typeof body.note === "string" ? body.note.trim() : "";
  if (rawNote.length > NOTE_MAX) throw new HttpError(400, "NOTE_TOO_LONG");
  const policy = (await getSettings(loc))?.note_on_stop ?? "off";
  // With the policy off the note field is not collected, so nothing is stored.
  const note = policy === "off" || !rawNote ? null : rawNote;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id, started_at FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL FOR UPDATE",
      { uid, loc }
    );
    if (!rows.length) throw new HttpError(409, "NO_OPEN_SESSION");
    if (policy === "required" && !note) throw new HttpError(400, "NOTE_REQUIRED");
    const s = rows[0];
    const t = now();
    await conn.execute(
      "UPDATE sessions SET ended_at = :t, duration_sec = :dur, closed_by = 'user', note = :note WHERE id = :id",
      { t, dur: t - s.started_at, note, id: s.id }
    );
    // Stopping during a break ends the break at the same instant.
    await conn.execute(
      "UPDATE breaks SET ended_at = :t WHERE session_id = :id AND ended_at IS NULL",
      { t, id: s.id }
    );
    const [[brk]] = await conn.execute(
      "SELECT COALESCE(SUM(ended_at - started_at), 0) AS break_sec FROM breaks WHERE session_id = :id",
      { id: s.id }
    );
    await conn.commit();
    return c.json({
      id: s.id, started_at: s.started_at, ended_at: t,
      duration_sec: t - s.started_at, break_sec: Number(brk.break_sec), note,
    });
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
});
```

- [ ] **Step 4: Note in the session detail**

In `app.get("/admin/sessions", ...)`, in the SELECT, replace

```js
    `SELECT s.id, s.user_id, e.name, s.started_at, s.ended_at, s.duration_sec, s.closed_by,
            ${BREAK_SEC_EXPR} AS break_sec
```

with

```js
    `SELECT s.id, s.user_id, e.name, s.started_at, s.ended_at, s.duration_sec, s.closed_by, s.note,
            ${BREAK_SEC_EXPR} AS break_sec
```

- [ ] **Step 5: CSV — worked hours, break minutes, note, formula guard**

In `app.get("/admin/export.csv", ...)`, replace from `const rows = await q(` through the `const lines = [ ... ];` statement with:

```js
  const rows = await q(
    `SELECT e.name, e.email, s.started_at, s.ended_at, s.duration_sec, s.closed_by, s.note,
            ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
       JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = :loc AND s.started_at >= :from AND s.started_at < :to
      ORDER BY e.name, s.started_at`,
    { loc, from, to, now: now() }
  );

  const fmt = (ts) => ts
    ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(Number(ts) * 1000))
    : "";
  // Notes are free text typed by employees: a cell starting with = + - @ would run as
  // a formula when the manager opens the file in Excel, so it is prefixed with '.
  const esc = (v) => {
    const s = String(v ?? "");
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [
    ["Employee", "Email", "Start", "End", "Hours", "Break (min)", "Closed by", "Note"],
    ...rows.map((r) => [r.name, r.email, fmt(r.started_at), fmt(r.ended_at),
      r.duration_sec ? ((Number(r.duration_sec) - Number(r.break_sec)) / 3600).toFixed(2) : "",
      Math.round(Number(r.break_sec) / 60), r.closed_by ?? "open", r.note ?? ""]),
  ];
```

- [ ] **Step 6: Restart the API and run the smoke test**

Run the restart command, then the smoke command.
Expected: **66 passed, 0 failed**.

- [ ] **Step 7: Document in `PROJECT.md` §8**

Replace the `/session/stop` row (from Task 2) with:

```markdown
| POST | `/session/stop` | Body اختياري: `{ note }` (حد أقصى 500 حرف). `200 { id, started_at, ended_at, duration_sec, break_sec, note }` — `duration_sec` المدة الكاملة، ووقت العمل = `duration_sec − break_sec`. إذا في استراحة مفتوحة بتسكّر معها. الملاحظة بتنحفظ بس إذا سياسة `note_on_stop` مش `off` · `400 NOTE_REQUIRED` · `400 NOTE_TOO_LONG` · `409 NO_OPEN_SESSION` |
```

Append to `/admin/sessions`: `، و\`note\``. Replace the `/admin/export.csv` description with: `CSV مع BOM: Employee, Email, Start, End, Hours (بدون الاستراحات), Break (min), Closed by, Note. الأوقات بالـ timezone تبع الحساب، وأي خلية بتبدأ بـ = + - @ بتنسبق بـ ' لحتى ما تشتغل كمعادلة`.

Append to رموز الأخطاء:

```markdown
| `NOTE_REQUIRED` | 400 | المدير خلّى الملاحظة إلزامية | اكتب ملاحظة قبل إنهاء الدوام |
| `NOTE_TOO_LONG` | 400 | أكتر من 500 حرف | الملاحظة طويلة جداً |
```

- [ ] **Step 8: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(stop): note on stop with off/optional/required policy; CSV adds break and note"
```

---

### Task 4: Settings UI — break toggle and note policy

**Files:**
- Modify: `web/src/components/SettingsPanel.jsx`, `web/src/components/SettingsPanel.test.jsx`, `web/src/styles.css`

**Interfaces:**
- Consumes (Task 1): `GET /admin/settings` returns `breaks_enabled` (boolean) and `note_on_stop`; `PUT /admin/settings` accepts both; errors `INVALID_BREAKS`, `INVALID_NOTE_POLICY`.
- Produces: checkbox labelled `تفعيل الاستراحات`, select labelled `ملاحظة عند إنهاء الدوام` with options `بدون` / `اختيارية` / `إلزامية` (values `off` / `optional` / `required`).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("SettingsPanel", ...)` block of `web/src/components/SettingsPanel.test.jsx`:

```jsx
  it("shows the saved break and note policies", async () => {
    const api = {
      get: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15, breaks_enabled: true, note_on_stop: "required" })),
      put: vi.fn(),
    };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("تفعيل الاستراحات")).toBeChecked();
    expect(screen.getByLabelText("ملاحظة عند إنهاء الدوام")).toHaveValue("required");
  });

  it("saves the break and note policies", async () => {
    const saved = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15, breaks_enabled: false, note_on_stop: "off" };
    const api = { get: vi.fn(async () => saved), put: vi.fn(async (_p, body) => ({ ...saved, ...body })) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByLabelText("تفعيل الاستراحات"));
    fireEvent.change(screen.getByLabelText("ملاحظة عند إنهاء الدوام"), { target: { value: "optional" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toEqual(expect.objectContaining({ breaks_enabled: true, note_on_stop: "optional" }));
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx vitest run src/components/SettingsPanel.test.jsx`
Expected: 2 FAIL (`Unable to find a label with the text of: تفعيل الاستراحات`).

- [ ] **Step 3: Implement**

In `web/src/components/SettingsPanel.jsx`, in `save()`'s PUT body, after the `late_grace_minutes: ...` property add:

```js
        breaks_enabled: Boolean(s.breaks_enabled),
        note_on_stop: s.note_on_stop ?? "off",
```

In the error mapping, replace

```js
        : e.code === "INVALID_GRACE" ? "سماح التأخير غير صحيح"
```

with

```js
        : e.code === "INVALID_GRACE" ? "سماح التأخير غير صحيح"
        : e.code === "INVALID_BREAKS" ? "إعداد الاستراحات غير صحيح"
        : e.code === "INVALID_NOTE_POLICY" ? "إعداد الملاحظة غير صحيح"
```

After the grace field `<div className="field">…سماح التأخير…</div>` line, add:

```jsx
      <div className="field check">
        <label><input type="checkbox" checked={Boolean(s.breaks_enabled)} onChange={(e) => setS({ ...s, breaks_enabled: e.target.checked })} />تفعيل الاستراحات</label>
      </div>
      <div className="field">
        <label htmlFor="note-policy">ملاحظة عند إنهاء الدوام</label>
        <select id="note-policy" value={s.note_on_stop ?? "off"} onChange={set("note_on_stop")}>
          <option value="off">بدون</option>
          <option value="optional">اختيارية</option>
          <option value="required">إلزامية</option>
        </select>
      </div>
```

In `web/src/styles.css`, after the line starting `.field .err{`, add:

```css
.field.check label{display:flex; align-items:center; gap:10px; cursor:pointer}
.field.check input{min-height:0; width:18px; height:18px; padding:0; accent-color:var(--accent)}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npx vitest run`
Expected: **58 passed**.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx web/src/styles.css
git commit -m "feat(settings-ui): break toggle and note-on-stop policy"
```

---

### Task 5: Employee screen — break button, stop note, correct live totals

**Files:**
- Create: `web/src/components/StopNoteDialog.jsx`, `web/src/components/StopNoteDialog.test.jsx`
- Modify: `web/src/components/EmployeeScreen.jsx`, `web/src/components/EmployeeScreen.test.jsx`, `web/src/components/Icon.jsx`, `web/src/styles.css`

**Interfaces:**
- Consumes (Tasks 1–3): `GET /me/settings` → `breaks_enabled`, `note_on_stop`; `GET /me/status` → `open_session.break_sec`, `open_break`, `worked_sec` (breaks excluded, exact at `server_time`); `POST /session/break/start|stop`; `POST /session/stop` with optional `{ note }`; error `NOTE_REQUIRED`.
- Produces: `StopNoteDialog({ required, loading, onConfirm(note: string), onCancel })`, confirm button labelled `تأكيد الإنهاء`, cancel `إلغاء`, textarea labelled `ملاحظة`, required error text `الملاحظة مطلوبة لإنهاء الدوام`. `Icon` name `pause`. CSS class `.overlay`.

Timer math this task fixes: today `todaySec = worked_sec + liveSec`, but `worked_sec` already includes the open session up to `server_time`, so a page opened mid-session counted that time twice. New rule: the server numbers are exact at `server_time`; the client only adds the seconds elapsed since then, and adds nothing while on a break.

- [ ] **Step 1: Write the failing dialog tests**

Create `web/src/components/StopNoteDialog.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import StopNoteDialog from "./StopNoteDialog.jsx";

describe("StopNoteDialog", () => {
  it("blocks an empty note when the note is required", () => {
    const onConfirm = vi.fn();
    render(<StopNoteDialog required onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("الملاحظة مطلوبة لإنهاء الدوام")).toBeInTheDocument();
  });

  it("allows an empty note when it is optional and trims what is typed", () => {
    const onConfirm = vi.fn();
    const { unmount } = render(<StopNoteDialog required={false} onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    expect(onConfirm).toHaveBeenLastCalledWith("");
    unmount();
    render(<StopNoteDialog required={false} onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("ملاحظة"), { target: { value: "  أنهيت العرض  " } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    expect(onConfirm).toHaveBeenLastCalledWith("أنهيت العرض");
  });
});
```

- [ ] **Step 2: Write the failing employee-screen tests**

In `web/src/components/EmployeeScreen.test.jsx`, replace the whole `makeApi` function with:

```jsx
const DEFAULT_SETTINGS = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null, breaks_enabled: false, note_on_stop: "off" };

function makeApi(status, settings = DEFAULT_SETTINGS, settingsError = null, post = vi.fn(async () => ({}))) {
  const get = vi.fn((path) => {
    if (path && path.startsWith("/me/settings")) {
      if (settingsError) return Promise.reject(settingsError);
      return Promise.resolve(settings);
    }
    if (path && path.startsWith("/me/sessions")) {
      return Promise.resolve({ sessions: [] });
    }
    return Promise.resolve(status);
  });
  return { get, post };
}

const nowSec = () => Math.floor(Date.now() / 1000);
```

Append inside `describe("EmployeeScreen", ...)`:

```jsx
  it("does not count a session that was already running on load twice", async () => {
    const t = nowSec();
    // worked_sec is exact at server_time and already includes the open hour.
    const api = makeApi({ open_session: { id: "s1", started_at: t - 3600, break_sec: 0 }, open_break: null, worked_sec: 3600, server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByRole("button", { name: /إنهاء الدوام/ });
    expect(screen.getByText("مجموع اليوم").querySelector("strong").textContent).toBe("1.00");
  });

  it("freezes the clock during a break and shows the break state", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 3600, break_sec: 600 }, open_break: { id: "b1", started_at: t - 600 }, worked_sec: 3000, server_time: t },
      { ...DEFAULT_SETTINGS, breaks_enabled: true }
    );
    const { container } = wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("في استراحة")).toBeInTheDocument();
    expect(container.querySelector(".timer").textContent).toBe("0:50:00");
    expect(screen.getByRole("button", { name: /إنهاء الاستراحة/ })).toBeInTheDocument();
  });

  it("hides the break button when breaks are disabled", async () => {
    const t = nowSec();
    const api = makeApi({ open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByRole("button", { name: /إنهاء الدوام/ });
    expect(screen.queryByRole("button", { name: /استراحة/ })).not.toBeInTheDocument();
  });

  it("starts a break", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, breaks_enabled: true }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /^استراحة$/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/break/start"));
  });

  it("stops directly when the note policy is off", async () => {
    const t = nowSec();
    const api = makeApi({ open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /إنهاء الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/stop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for a required note and sends it with the stop", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, note_on_stop: "required" }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const stop = await screen.findByRole("button", { name: /إنهاء الدوام/ });
    // Let the /me/settings effect land: clicking before it would still see policy "off".
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/settings"));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(stop);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("ملاحظة"), { target: { value: "أنهيت العرض" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/stop", { note: "أنهيت العرض" }));
  });

  it("opens the note dialog when the server says a note is required", async () => {
    const t = nowSec();
    const post = vi.fn(async (path) => {
      if (path === "/session/stop") throw Object.assign(new Error("NOTE_REQUIRED"), { code: "NOTE_REQUIRED" });
      return {};
    });
    // Settings fail to load, so the screen believes the policy is off.
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      null, new Error("NETWORK"), post
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /إنهاء الدوام/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("حدث خطأ، حاول مرة أخرى")).not.toBeInTheDocument();
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd web && npx vitest run src/components/StopNoteDialog.test.jsx src/components/EmployeeScreen.test.jsx`
Expected: StopNoteDialog file fails to import; the 7 new EmployeeScreen tests FAIL; the 6 existing ones still PASS.

- [ ] **Step 4: Add the dialog, icon and overlay style**

Create `web/src/components/StopNoteDialog.jsx`:

```jsx
import { useState } from "react";
import Button from "./Button.jsx";

const NOTE_MAX = 500;

export default function StopNoteDialog({ required, loading, onConfirm, onCancel }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function confirm() {
    const trimmed = note.trim();
    if (required && !trimmed) { setError("الملاحظة مطلوبة لإنهاء الدوام"); return; }
    onConfirm(trimmed);
  }

  return (
    <div className="overlay">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="stop-note-title">
        <h2 id="stop-note-title">إنهاء الدوام</h2>
        <p className="hint">{required ? "اكتب باختصار ما أنجزته." : "يمكنك كتابة ملاحظة قصيرة عمّا أنجزته (اختياري)."}</p>
        <div className="field">
          <label htmlFor="stop-note">ملاحظة</label>
          <textarea id="stop-note" maxLength={NOTE_MAX} value={note}
            aria-invalid={error ? "true" : undefined}
            onChange={(e) => { setNote(e.target.value); setError(""); }} />
          {error && <span className="err">{error}</span>}
        </div>
        <div className="dlg-a">
          <Button variant="danger" onClick={confirm} loading={loading}>تأكيد الإنهاء</Button>
          <Button variant="ghost" onClick={onCancel}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}
```

In `web/src/components/Icon.jsx`, inside `PATHS`, after the `stop:` entry add:

```jsx
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>,
```

In `web/src/styles.css`, after the `.dlg-a{...}` line add:

```css
.overlay{position:fixed; inset:0; background:rgba(20,20,37,.5); display:grid; place-items:center; z-index:60; padding:16px}
.overlay .dlg{background:var(--panel); border-radius:var(--r-lg); width:min(480px, 100%)}
```

- [ ] **Step 5: Rewrite `EmployeeScreen.jsx`**

Replace the whole file with:

```jsx
import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatClock, formatHours, serverOffset, nowWithOffset } from "../time.js";
import MyHistory from "./MyHistory.jsx";
import StopNoteDialog from "./StopNoteDialog.jsx";

export default function EmployeeScreen({ api, user }) {
  const [status, setStatus] = useState(null);
  const [weekSec, setWeekSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);
  const [targetSec, setTargetSec] = useState(8 * 3600);
  const [policy, setPolicy] = useState({ breaks_enabled: false, note_on_stop: "off" });
  const [askNote, setAskNote] = useState(false);
  const offsetRef = useRef(0);
  const toast = useToast();

  async function refresh() {
    const s = await api.get("/me/status");
    offsetRef.current = serverOffset(s.server_time);
    setStatus(s);
    const weekFrom = s.server_time - 7 * 86400;
    const wk = await api.get(`/me/status?since=${weekFrom}`);
    setWeekSec(wk.worked_sec);
  }

  useEffect(() => { refresh().catch((e) => setError(e.code || "INTERNAL_ERROR")); }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get("/me/settings");
        setTargetSec(Number(cfg.daily_target_hours) * 3600);
        setPolicy({ breaks_enabled: Boolean(cfg.breaks_enabled), note_on_stop: cfg.note_on_stop ?? "off" });
      } catch {
        // Settings are a convenience here: fall back to an 8-hour target, no break
        // button and no note prompt. The server still enforces a required note.
      }
    })();
  }, [api]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function run(action, message) {
    setLoading(true); setError("");
    try {
      await action();
      await refresh();
      toast(message);
      return true;
    } catch (e) {
      if (e.code === "NOTE_REQUIRED") {
        // Our copy of the policy was stale or failed to load; the server is the authority.
        setPolicy((p) => ({ ...p, note_on_stop: "required" }));
        setAskNote(true);
        return false;
      }
      setError(e.code || "INTERNAL_ERROR");
      return false;
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!status?.open_session) return run(() => api.post("/session/start"), "بدأ دوامك");
    if (policy.note_on_stop !== "off") { setAskNote(true); return undefined; }
    return run(() => api.post("/session/stop"), "انتهى دوامك");
  }

  async function stopWithNote(note) {
    const ok = await run(() => api.post("/session/stop", note ? { note } : {}), "انتهى دوامك");
    if (ok) setAskNote(false);
  }

  function toggleBreak() {
    return status?.open_break
      ? run(() => api.post("/session/break/stop"), "انتهت الاستراحة")
      : run(() => api.post("/session/break/start"), "بدأت الاستراحة");
  }

  if (!status && !error) return <div className="panel muted">جارٍ التحميل…</div>;

  const open = status?.open_session;
  const onBreak = Boolean(status?.open_break);
  // The server's numbers are exact at server_time. The client only adds the seconds
  // elapsed since then, and adds nothing while a break is running.
  const sinceSnapshot = open && !onBreak ? Math.max(0, nowWithOffset(offsetRef.current) - status.server_time) : 0;
  const sessionSec = open ? status.server_time - open.started_at - (open.break_sec ?? 0) + sinceSnapshot : 0;
  const todaySec = (status?.worked_sec ?? 0) + sinceSnapshot;
  const clock = formatClock(sessionSec);
  const remain = Math.max(0, targetSec - todaySec);
  const pct = Math.min(100, (todaySec / targetSec) * 100);
  const name = user?.name || "";
  const [chipClass, chipText] = onBreak ? ["break", "في استراحة"] : open ? ["work", "داخل الدوام"] : ["off", "لم يسجّل الدخول"];
  // An employee already on a break can always end it, even if breaks were switched off.
  const showBreak = open && (policy.breaks_enabled || onBreak);

  return (
    <div className="grid emp">
      <div className="hero">
        <div>
          <div className="hero-top">
            <span className="hello">مرحباً{name ? `، ${name}` : ""}</span>
            <span className={`chip ${chipClass}`}>{chipText}</span>
          </div>
          <div className="timer" aria-live="off">{clock.h}:{clock.mm}<span className="sec">:{clock.ss}</span></div>
          <div className="hero-meta">
            <div>ساعات اليوم المطلوبة<strong className="ltr">{formatHours(targetSec)}</strong></div>
            <div>المتبقي<strong className="ltr">{remain > 0 ? formatHours(remain) : "اكتملت"}</strong></div>
            <div>مجموع اليوم<strong className="ltr">{formatHours(todaySec)}</strong></div>
          </div>
          <div className="goal" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <i style={{ width: pct + "%" }} />
          </div>
        </div>
        <div className="actions">
          <Button onClick={toggle} loading={loading} variant={open ? "danger" : "primary"} size="lg">
            <Icon name={open ? "stop" : "play"} />{open ? "إنهاء الدوام" : "بدء الدوام"}
          </Button>
          {showBreak && (
            <Button onClick={toggleBreak} loading={loading} variant="ghost" size="lg">
              <Icon name={onBreak ? "play" : "pause"} />{onBreak ? "إنهاء الاستراحة" : "استراحة"}
            </Button>
          )}
        </div>
      </div>

      <section className="panel">
        <div className="panel-h"><h2>ساعاتي هذا الأسبوع</h2></div>
        <p className="hero-meta"><span>المجموع<strong className="ltr">{formatHours(weekSec)}</strong></span></p>
      </section>

      <MyHistory api={api} />

      {askNote && (
        <StopNoteDialog required={policy.note_on_stop === "required"} loading={loading}
          onConfirm={stopWithNote} onCancel={() => setAskNote(false)} />
      )}

      {error && <div className="panel error">حدث خطأ، حاول مرة أخرى</div>}
    </div>
  );
}
```

- [ ] **Step 6: Run the full frontend suite**

Run: `cd web && npx vitest run`
Expected: **67 passed** (58 + 2 dialog + 7 employee).

If `"does not count … twice"` fails with `2.00`, the old `todaySec` formula is still in place. If a `getByRole("button", { name: /إنهاء الدوام/ })` query finds two buttons, the dialog's confirm button must be `تأكيد الإنهاء`, not `إنهاء الدوام`.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/StopNoteDialog.jsx web/src/components/StopNoteDialog.test.jsx web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx web/src/components/Icon.jsx web/src/styles.css
git commit -m "feat(employee): break button, note on stop, and live totals that don't double-count"
```

---

### Task 6: Manager and history views — break and note

**Files:**
- Modify: `web/src/time.js`, `web/src/time.test.js`, `web/src/components/ReportPanel.jsx` (+test), `web/src/components/LiveFloor.jsx` (+test), `web/src/components/MyHistory.jsx` (+test), `web/src/styles.css`

**Interfaces:**
- Consumes (Tasks 2–3): `/admin/sessions` rows carry `break_sec` and `note`; `/admin/live` rows carry `break_started_at`; `/me/sessions` rows carry `break_sec`.
- Produces: `formatBreak(sec)` in `web/src/time.js` → `""` for 0/null, otherwise `"N د"` with N = minutes rounded, minimum 1. Detail table columns `الاستراحة` and `الملاحظة`.

- [ ] **Step 1: Write the failing tests**

In `web/src/time.test.js`, add `formatBreak` to the import list from `"./time.js"` and append:

```js
describe("formatBreak", () => {
  it("shows whole minutes, never 0 for a real break", () => {
    expect(formatBreak(20)).toBe("1 د");
    expect(formatBreak(15 * 60)).toBe("15 د");
    expect(formatBreak(90 * 60)).toBe("90 د");
  });
  it("is empty when there was no break", () => {
    expect(formatBreak(0)).toBe("");
    expect(formatBreak(null)).toBe("");
  });
});
```

Append inside `describe("ReportPanel", ...)` in `web/src/components/ReportPanel.test.jsx`:

```jsx
  it("shows each session's break and note in the detail", async () => {
    const start = Date.UTC(2026, 8, 24, 6, 0) / 1000;
    const api = makeApi({
      sessions: [{ id: 1, user_id: "a", started_at: start, ended_at: start + 8 * 3600, closed_by: "user",
                   late_by_sec: null, break_sec: 30 * 60, note: "أنهيت عرض السعر" }],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("30 د")).toBeInTheDocument();
    expect(screen.getByText("أنهيت عرض السعر")).toBeInTheDocument();
    expect(screen.getByText("الملاحظة")).toBeInTheDocument();
  });
```

Append inside `describe("LiveFloor", ...)` in `web/src/components/LiveFloor.test.jsx`:

```jsx
  it("marks an employee who is on a break", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 3600, break_started_at: now - 300 }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText(/استراحة/)).toBeInTheDocument();
    expect(screen.getByText("داخل الدوام").closest(".lane").textContent).toContain("أحمد");
  });
```

Append inside `describe("MyHistory", ...)` in `web/src/components/MyHistory.test.jsx`:

```jsx
  it("shows worked hours without the breaks", async () => {
    const api = {
      get: vi.fn(async () => ({
        timezone: "Asia/Riyadh",
        sessions: [{ id: "d", started_at: 1758700000, ended_at: 1758728800, duration_sec: 28800, break_sec: 1800, closed_by: "user" }],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("7.50")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx vitest run`
Expected: the 5 new tests FAIL (2 `formatBreak`, ReportPanel, LiveFloor, MyHistory); the 67 earlier tests PASS.

- [ ] **Step 3: Implement**

Append to `web/src/time.js`:

```js
export function formatBreak(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  return `${Math.max(1, Math.round(s / 60))} د`;
}
```

In `web/src/components/ReportPanel.jsx`, change the import to

```js
import { formatHours, formatLateness, formatStamp, formatBreak } from "../time.js";
```

and replace the detail table's `<thead>…</thead>` and row `<tr key={s.id}>…</tr>` with:

```jsx
            <thead><tr>
              <th scope="col">البداية</th><th scope="col">النهاية</th>
              <th scope="col">الاستراحة</th><th scope="col">التأخير</th>
              <th scope="col">الإغلاق</th><th scope="col">الملاحظة</th><th scope="col"></th>
            </tr></thead>
            <tbody>{detail.sessions.map((s) => (
              <tr key={s.id}>
                <td className="ltr">{formatStamp(s.started_at, detail.timezone)}</td>
                <td className="ltr">{s.ended_at ? formatStamp(s.ended_at, detail.timezone) : "مفتوحة"}</td>
                <td>{formatBreak(s.break_sec) || "—"}</td>
                <td className="late">{formatLateness(s.late_by_sec)}</td>
                <td>{s.closed_by ?? "—"}</td>
                <td className="note">{s.note || "—"}</td>
                <td><Button variant="ghost" size="sm" onClick={() => setEditing(s)}>تعديل</Button></td>
              </tr>
            ))}</tbody>
```

In `web/src/components/LiveFloor.jsx`, replace

```jsx
            {live && <div className="m">{formatDuration(nowWithOffset(offsetRef.current) - p.started_at)}</div>}
```

with

```jsx
            {live && (p.break_started_at
              ? <div className="m break">استراحة · {formatDuration(nowWithOffset(offsetRef.current) - p.break_started_at)}</div>
              : <div className="m">{formatDuration(nowWithOffset(offsetRef.current) - p.started_at)}</div>)}
```

In `web/src/components/MyHistory.jsx`, replace

```jsx
                  <td className="num">{s.duration_sec ? formatHours(s.duration_sec) : "—"}</td>
```

with

```jsx
                  <td className="num">{s.duration_sec ? formatHours(s.duration_sec - (s.break_sec ?? 0)) : "—"}</td>
```

In `web/src/styles.css`, after the `td.late{...}` line add:

```css
td.note{max-width:280px; white-space:normal; overflow-wrap:anywhere; color:var(--muted)}
```

and after the `.person .m.late{...}` line add:

```css
.person .m.break{color:var(--warn); font-weight:600}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npx vitest run`
Expected: **72 passed**.

- [ ] **Step 5: Commit**

```bash
git add web/src/time.js web/src/time.test.js web/src/components/ReportPanel.jsx web/src/components/ReportPanel.test.jsx web/src/components/LiveFloor.jsx web/src/components/LiveFloor.test.jsx web/src/components/MyHistory.jsx web/src/components/MyHistory.test.jsx web/src/styles.css
git commit -m "feat(manager-ui): show breaks and notes in detail, live floor and history"
```

---

## After all tasks (controller, not a subagent)

1. Full verification: `npm run test:unit` (8), `cd web && npx vitest run` (72), smoke (66, 0 failed), `npm run build` succeeds.
2. Update `docs/PROGRESS.md` (Current State + Session Log) and append to `docs/DECISIONS.md`: worked time computed on read with breaks clipped to session and window (`duration_sec` stays wall-clock); note stored only when the policy is not `off`; CSV formula guard; client live totals extrapolate from `server_time` (double-count fix).
3. **Production migration first:** the user runs `migrations/002_breaks_and_notes.sql` in phpMyAdmin (SQL tab on `u859703690_timeclockTerra`), then confirms with `SHOW TABLES LIKE 'breaks';`. Record the date in `migrations/README.md`.
4. Only then push `main`, wait for the new bundle hash, and verify `/health` and the manager and employee screens inside GHL.

## Out of scope (noticed while planning)

- "مجموع اليوم" on the employee screen is the last rolling 24 hours (`/me/status` default `since = now − 86400`), not the local calendar day. Changing it alters a number employees already see; left for a separate decision.
- Spec §9 asks for mobile verification (GHL mobile app rendering the Custom Page) before phase 2. It does not block this code, but field staff depend on it.
