# Attendance Policies — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the employee screen honour the company's real daily target, activate the
already-stored `work_start` to surface lateness in the manager report, and give the
employee a 7-day history of their own sessions.

**Architecture:** Three additive slices on the existing Hono + React app. One new
settings column (`late_grace_minutes`), two new employee-scoped read endpoints
(`/me/settings`, `/me/sessions`), one new computed column in `/admin/report`
(`late_days`). No change to the session model, no change to how sessions are created
or closed.

**Tech Stack:** Node 20 ESM · Hono 4 · mysql2 (named placeholders) · React 18 · Vite 5 ·
Vitest 2 + React Testing Library · MariaDB/MySQL

**Spec:** `docs/superpowers/specs/2026-09-24-attendance-policies-design.md`

## Global Constraints

- Plain ESM JavaScript. No TypeScript, no backend build step. 2-space indent, semicolons.
- SQL must run on **both MySQL 8 and MariaDB 10.2+**. Do not use partial indexes,
  `UPDATE ... RETURNING`, or `INSERT ... AS alias ON DUPLICATE KEY`.
- `location_id` and `user_id` come **only** from `c.get("claims")` — never from the
  request body, query string or path.
- Every `/admin/*` route keeps `authed, managerOnly`. New `/me/*` routes use `authed`
  only, and must scope every query to the caller's own `uid` **and** `loc`.
- All timestamps are UNIX seconds (UTC). Timezone offsets are applied explicitly for
  display and for day-bucketing, via the existing `tzOffsetSec(tz)` helper.
- Errors are `{ error: "CODE" }` thrown as `HttpError`. New codes get added to
  `PROJECT.md` §8.
- Frontend is Arabic RTL with **Western digits** (1, 2, 3). Token lives in memory only.
- **Migration order is mandatory: apply the SQL to the database first, then deploy the
  code.** Deploys do not run migrations.

---

### Task 1: Add `late_grace_minutes` to settings

**Files:**
- Modify: `schema.sql:5-12` (the `settings` table)
- Modify: `src/server.js:443-458` (`PUT /admin/settings`)
- Test: `scripts/smoke-test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `settings.late_grace_minutes` (INT, NOT NULL, DEFAULT 15), returned by
  `GET /admin/settings` and accepted by `PUT /admin/settings` as
  `late_grace_minutes: number`. Task 2 and Task 3 read it.

- [ ] **Step 1: Add the column to `schema.sql`**

In `schema.sql`, inside `CREATE TABLE IF NOT EXISTS settings`, add the column after
`work_start`:

```sql
  work_start         CHAR(5)      NULL DEFAULT '09:00',
  late_grace_minutes INT          NOT NULL DEFAULT 15,
  max_session_hours  DECIMAL(4,2) NOT NULL DEFAULT 12,
```

- [ ] **Step 2: Apply the column to your local database**

Run:

```bash
docker exec -i timeclock-db mariadb -uroot -plocal timeclock -e "ALTER TABLE settings ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 15 AFTER work_start;"
```

Expected: no output (success). Verify:

```bash
docker exec timeclock-db mariadb -uroot -plocal timeclock -e "DESCRIBE settings;"
```

Expected: a `late_grace_minutes` row with `int(11)`, `NO`, default `15`.

- [ ] **Step 3: Write the failing smoke-test check**

In `scripts/smoke-test.mjs`, find the existing settings check:

```js
check("settings update", set.status === 200 && set.body.timezone === "Asia/Dubai");
```

Immediately **above** the line that defines `set`, change the settings PUT body to
include the new field, then add a check below. The existing block reads:

```js
const set = await call(M, "PUT", "/admin/settings", { timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12 });
```

Replace it with:

```js
const set = await call(M, "PUT", "/admin/settings", { timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 20 });
check("late_grace_minutes saved", set.body?.late_grace_minutes === 20);
const badGrace = await call(M, "PUT", "/admin/settings", { timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, late_grace_minutes: 500 });
check("late_grace_minutes out of range → 400", badGrace.status === 400);
```

- [ ] **Step 4: Run the smoke test to verify the new checks fail**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock && BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke
```

Expected: `FAIL late_grace_minutes saved` and `FAIL late_grace_minutes out of range → 400`.

- [ ] **Step 5: Accept and validate the field in `PUT /admin/settings`**

In `src/server.js`, inside `app.put("/admin/settings", ...)`, after the
`INVALID_WORK_START` check, add validation:

```js
  const grace = b.late_grace_minutes === undefined ? 15 : Number(b.late_grace_minutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new HttpError(400, "INVALID_GRACE");
```

Then extend the UPDATE statement and its parameters:

```js
  await q(
    `UPDATE settings SET timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         late_grace_minutes = :grace, max_session_hours = :max, updated_at = :t
      WHERE location_id = :loc`,
    { tz: b.timezone, target, ws: b.work_start ?? null, grace, max, t: now(), loc }
  );
```

- [ ] **Step 6: Run the smoke test to verify the new checks pass**

Run the same command as Step 4.
Expected: `PASS late_grace_minutes saved` and `PASS late_grace_minutes out of range → 400`, 0 failed.

- [ ] **Step 7: Add the error code to PROJECT.md**

In `PROJECT.md` §8 under "رموز الأخطاء", add a row in the same format as the
neighbouring rows:

```
| `INVALID_GRACE` | 400 | سماح التأخير خارج المدى (0–240 دقيقة) | صحّح القيمة |
```

- [ ] **Step 8: Commit**

```bash
git add schema.sql src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(settings): add late_grace_minutes policy"
```

---

### Task 2: Expose the location's settings to the employee

**Files:**
- Modify: `src/server.js` — add `GET /me/settings` directly after the existing
  `app.get("/me/status", ...)` handler ends
- Modify: `web/src/components/EmployeeScreen.jsx:7` (remove the hardcoded constant) and
  its `refresh()` function
- Test: `web/src/components/EmployeeScreen.test.jsx`, `scripts/smoke-test.mjs`

**Interfaces:**
- Consumes: `settings.daily_target_hours`, `settings.timezone`, `settings.work_start`
  from Task 1's table.
- Produces: `GET /me/settings` → `{ daily_target_hours: number, timezone: string,
  work_start: string|null }`. Employee-accessible. Task 3 does not use it.

- [ ] **Step 1: Write the failing smoke-test check**

In `scripts/smoke-test.mjs`, after the `check("settings update", ...)` line, add:

```js
const meSet = await call(E, "GET", "/me/settings");
check("employee can read location settings", meSet.status === 200 && meSet.body?.daily_target_hours === 8);
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock && BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke
```

Expected: `FAIL employee can read location settings`.

- [ ] **Step 3: Add the endpoint**

In `src/server.js`, immediately after the `/me/status` handler's closing `});`, add:

```js
app.get("/me/settings", authed, async (c) => {
  const st = await getSettings(c.get("claims").loc);
  return c.json({
    daily_target_hours: Number(st?.daily_target_hours ?? 8),
    timezone: st?.timezone ?? "Asia/Riyadh",
    work_start: st?.work_start ?? null,
  });
});
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run the same command as Step 2.
Expected: `PASS employee can read location settings`, 0 failed.

- [ ] **Step 5: Write the failing frontend test**

In `web/src/components/EmployeeScreen.test.jsx`, replace the `makeApi` helper so it can
answer both endpoints, and add a test. The current helper is:

```js
function makeApi(status) {
  return { get: vi.fn(async () => status), post: vi.fn(async () => ({})) };
}
```

Replace it with:

```js
function makeApi(status, settings = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null }) {
  return {
    get: vi.fn(async (path) => (path.startsWith("/me/settings") ? settings : status)),
    post: vi.fn(async () => ({})),
  };
}
```

Then add this test inside the `describe("EmployeeScreen", ...)` block:

```js
  it("uses the location's daily target, not a hardcoded 8", async () => {
    const api = makeApi(
      { open_session: null, worked_sec: 0, server_time: 1000 },
      { daily_target_hours: 6, timezone: "Asia/Riyadh", work_start: null }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("6.00")).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the frontend test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run src/components/EmployeeScreen.test.jsx
```

Expected: FAIL — the screen renders `8.00`, so `findByText("6.00")` times out.

- [ ] **Step 7: Read the target from the API**

In `web/src/components/EmployeeScreen.jsx`, delete line 7:

```js
const DAILY_TARGET_SEC = 8 * 3600; // employee has no settings route; spec §7 default
```

Add state next to the other `useState` calls at the top of the component:

```js
  const [targetSec, setTargetSec] = useState(8 * 3600);
```

Inside `refresh()`, after `setWeekSec(wk.worked_sec);`, add:

```js
    const cfg = await api.get("/me/settings");
    setTargetSec(Number(cfg.daily_target_hours) * 3600);
```

Then replace every remaining use of `DAILY_TARGET_SEC` with `targetSec`. There are
three, all in the render block:

```js
  const remain = Math.max(0, targetSec - todaySec);
  const pct = Math.min(100, (todaySec / targetSec) * 100);
```

and

```js
            <div>ساعات اليوم المطلوبة<strong className="ltr">{formatHours(targetSec)}</strong></div>
```

- [ ] **Step 8: Run the frontend tests to verify they pass**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run
```

Expected: all tests pass (37 total — the 36 existing plus the new one).

- [ ] **Step 9: Commit**

```bash
git add src/server.js web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx scripts/smoke-test.mjs
git commit -m "fix(employee): read daily target from location settings"
```

---

### Task 3: Compute and show late days in the manager report

**Files:**
- Modify: `src/server.js:318-346` (`GET /admin/report`)
- Modify: `web/src/components/ReportPanel.jsx:81-100` (table head and body)
- Modify: `web/src/components/SettingsPanel.jsx` (grace input)
- Test: `web/src/components/ReportPanel.test.jsx`, `web/src/components/SettingsPanel.test.jsx`, `scripts/smoke-test.mjs`

**Interfaces:**
- Consumes: `settings.late_grace_minutes` and `settings.work_start` from Task 1.
- Produces: `GET /admin/report` response gains `late_days: number` per employee, and
  the top-level response gains `work_start: string|null`. When `work_start` is NULL,
  `late_days` is `0` and the UI shows `—`.

- [ ] **Step 1: Write the failing smoke-test check**

In `scripts/smoke-test.mjs`, find the existing report check:

```js
check("report returns worked_sec", row && row.worked_sec >= 1);
```

Add directly below it:

```js
check("report returns late_days", row && typeof row.late_days === "number");
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock && BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke
```

Expected: `FAIL report returns late_days`.

- [ ] **Step 3: Compute `late_days` in the report query**

In `src/server.js`, inside `app.get("/admin/report", ...)`, after the existing
`const tz = st?.timezone ?? "Asia/Riyadh";` line, add:

```js
  // Lateness threshold as seconds-since-local-midnight; NULL work_start disables it.
  const ws = st?.work_start ?? null;
  const graceSec = Number(st?.late_grace_minutes ?? 15) * 60;
  const lateAfterSec = ws
    ? Number(ws.slice(0, 2)) * 3600 + Number(ws.slice(3, 5)) * 60 + graceSec
    : null;
```

Then add a `late_days` expression to the SELECT list, directly after the
`days_present` line:

```sql
            COUNT(DISTINCT CASE
              WHEN :lateAfter IS NOT NULL
               AND s.started_at + :off = (
                     SELECT MIN(s2.started_at + :off) FROM sessions s2
                      WHERE s2.user_id = s.user_id AND s2.location_id = s.location_id
                        AND DATE(FROM_UNIXTIME(s2.started_at + :off)) = DATE(FROM_UNIXTIME(s.started_at + :off))
                   )
               AND TIME_TO_SEC(TIME(FROM_UNIXTIME(s.started_at + :off))) > :lateAfter
              THEN DATE(FROM_UNIXTIME(s.started_at + :off)) END)          AS late_days,
```

And add the two new parameters to the query's parameter object:

```js
    { now: now(), to, from, off: tzOffsetSec(tz), lateAfter: lateAfterSec, loc }
```

Finally extend the JSON response so the UI knows whether lateness is configured:

```js
  return c.json({
    from, to, timezone: tz,
    daily_target_hours: st?.daily_target_hours ?? 8,
    work_start: ws,
    employees: employees.map((r) => ({ ...r, worked_sec: Number(r.worked_sec) })),
  });
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run the same command as Step 2.
Expected: `PASS report returns late_days`, 0 failed.

- [ ] **Step 5: Write the failing ReportPanel test**

In `web/src/components/ReportPanel.test.jsx`, add this test inside the existing
`describe` block:

```js
  it("shows a late-days column when work_start is set", async () => {
    const api = {
      get: vi.fn(async () => ({
        from: 0, to: 1, timezone: "Europe/Istanbul", daily_target_hours: 8, work_start: "09:00",
        employees: [{ user_id: "u1", name: "أحمد", worked_sec: 3600, days_present: 2, auto_closed: 0, late_days: 1 }],
      })),
      download: vi.fn(),
    };
    render(<ReportPanel api={api} />);
    expect(await screen.findByText("أيام التأخير")).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run src/components/ReportPanel.test.jsx
```

Expected: FAIL — no element with text `أيام التأخير`.

- [ ] **Step 7: Add the column to the table**

In `web/src/components/ReportPanel.jsx`, add a header cell between `أيام الحضور` and
`مغلقة تلقائياً`:

```jsx
            <th scope="col">الإنجاز</th><th scope="col">أيام الحضور</th>
            <th scope="col">أيام التأخير</th><th scope="col">مغلقة تلقائياً</th>
```

Add the matching body cell between the `days_present` and `auto_closed` cells:

```jsx
                  <td className="num">{e.days_present}</td>
                  <td className="num">{report.work_start ? e.late_days : "—"}</td>
                  <td className="num">{e.auto_closed}</td>
```

Update the empty-state `colSpan` from `6` to `7`:

```jsx
            }) : <tr><td colSpan={7} className="empty">لا يوجد موظفون مطابقون.</td></tr>}
```

Note: the variable holding the fetched report in this file must be in scope where the
cell is rendered. If it is named something other than `report`, use that name instead —
do not rename it.

- [ ] **Step 8: Run the frontend tests to verify they pass**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run
```

Expected: all tests pass (38 total).

- [ ] **Step 9: Write the failing SettingsPanel test**

In `web/src/components/SettingsPanel.test.jsx`, extend the mocked `get` and `put`
responses to include `late_grace_minutes: 15`, then add:

```js
  it("renders the late grace field", async () => {
    render(<ToastProvider><SettingsPanel api={api} /></ToastProvider>);
    expect(await screen.findByLabelText("سماح التأخير (دقائق)")).toBeInTheDocument();
  });
```

- [ ] **Step 10: Run the test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run src/components/SettingsPanel.test.jsx
```

Expected: FAIL — no field labelled `سماح التأخير (دقائق)`.

- [ ] **Step 11: Add the grace field to the settings form**

In `web/src/components/SettingsPanel.jsx`, add a field directly after the
`بداية الدوام` field:

```jsx
      <div className="field"><label htmlFor="grace">سماح التأخير (دقائق)</label><input id="grace" type="number" step="1" min="0" max="240" value={s.late_grace_minutes ?? 15} onChange={set("late_grace_minutes")} /></div>
```

Give the `بداية الدوام` input an `id`/`htmlFor` pair in the same style if it lacks one,
so `findByLabelText` resolves reliably.

Then include the field in the save payload:

```js
        work_start: s.work_start || null,
        late_grace_minutes: Number(s.late_grace_minutes ?? 15),
```

And add an error message branch alongside the existing ones:

```js
        : e.code === "INVALID_GRACE" ? "سماح التأخير غير صحيح"
```

- [ ] **Step 12: Run the full frontend suite**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run
```

Expected: all tests pass (39 total).

- [ ] **Step 13: Commit**

```bash
git add src/server.js web/src/components/ReportPanel.jsx web/src/components/ReportPanel.test.jsx web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx scripts/smoke-test.mjs
git commit -m "feat(report): compute late days from work_start and grace"
```

---

### Task 4: Employee's own 7-day history

**Files:**
- Modify: `src/server.js` — add `GET /me/sessions` directly after `GET /me/settings`
- Create: `web/src/components/MyHistory.jsx`
- Create: `web/src/components/MyHistory.test.jsx`
- Modify: `web/src/components/EmployeeScreen.jsx` (render `<MyHistory />`)
- Test: `scripts/smoke-test.mjs`

**Interfaces:**
- Consumes: `api` object with `get(path)`; the `formatHours` helper from `../time.js`.
- Produces: `GET /me/sessions?days=N` → `{ sessions: [{ id, started_at, ended_at,
  duration_sec, closed_by }] }`, newest first, scoped to the caller. `MyHistory` is a
  default-exported React component taking a single `api` prop.

- [ ] **Step 1: Write the failing smoke-test checks**

In `scripts/smoke-test.mjs`, after the `check("sessions list", !!sid);` line, add:

```js
const mine = await call(E, "GET", "/me/sessions?days=7");
check("employee sees own sessions", mine.status === 200 && Array.isArray(mine.body?.sessions) && mine.body.sessions.length >= 1);
const mgrMine = await call(M, "GET", "/me/sessions?days=7");
check("manager's own history excludes the employee's rows", (mgrMine.body?.sessions ?? []).length === 0);
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock && BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke
```

Expected: `FAIL employee sees own sessions`.

- [ ] **Step 3: Add the endpoint**

In `src/server.js`, immediately after the `/me/settings` handler's closing `});`, add:

```js
app.get("/me/sessions", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const days = intParam(c, "days", 7);
  if (days < 1 || days > 31) throw new HttpError(400, "INVALID_DAYS");
  const from = now() - days * 86400;
  const sessions = await q(
    `SELECT id, started_at, ended_at, duration_sec, closed_by
       FROM sessions
      WHERE user_id = :uid AND location_id = :loc AND started_at >= :from
      ORDER BY started_at DESC
      LIMIT 100`,
    { uid, loc, from }
  );
  return c.json({ sessions });
});
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run the same command as Step 2.
Expected: both new checks `PASS`, 0 failed.

- [ ] **Step 5: Add the error code to PROJECT.md**

In `PROJECT.md` §8 under "رموز الأخطاء", add:

```
| `INVALID_DAYS` | 400 | عدد الأيام خارج المدى (1–31) | صحّح القيمة |
```

- [ ] **Step 6: Write the failing component test**

Create `web/src/components/MyHistory.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import MyHistory from "./MyHistory.jsx";

describe("MyHistory", () => {
  it("lists the employee's recent sessions", async () => {
    const api = {
      get: vi.fn(async () => ({
        sessions: [
          { id: "a", started_at: 1758700000, ended_at: 1758728800, duration_sec: 28800, closed_by: "user" },
        ],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("8.00")).toBeInTheDocument();
  });

  it("flags auto-closed sessions", async () => {
    const api = {
      get: vi.fn(async () => ({
        sessions: [
          { id: "b", started_at: 1758700000, ended_at: 1758743200, duration_sec: 43200, closed_by: "auto" },
        ],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("أُغلقت تلقائياً")).toBeInTheDocument();
  });

  it("shows an empty state when there are no sessions", async () => {
    const api = { get: vi.fn(async () => ({ sessions: [] })) };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("لا توجد جلسات في آخر 7 أيام.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run src/components/MyHistory.test.jsx
```

Expected: FAIL — cannot resolve `./MyHistory.jsx`.

- [ ] **Step 8: Create the component**

Create `web/src/components/MyHistory.jsx`:

```jsx
import { useEffect, useState } from "react";
import { formatHours } from "../time.js";

const fmt = (ts) =>
  ts
    ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        .format(new Date(Number(ts) * 1000))
    : "—";

export default function MyHistory({ api }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/me/sessions?days=7")
      .then((r) => setSessions(r.sessions))
      .catch(() => setError("حدث خطأ، حاول مرة أخرى"));
  }, []);

  if (error) return <section className="panel error">{error}</section>;
  if (!sessions) return <section className="panel muted">جارٍ التحميل…</section>;

  return (
    <section className="panel">
      <div className="panel-h"><h2>سجلّي — آخر 7 أيام</h2></div>
      {sessions.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">البداية</th><th scope="col">النهاية</th><th scope="col">الساعات</th><th scope="col"></th>
            </tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="ltr">{fmt(s.started_at)}</td>
                  <td className="ltr">{fmt(s.ended_at)}</td>
                  <td className="num">{s.duration_sec ? formatHours(s.duration_sec) : "—"}</td>
                  <td>{s.closed_by === "auto" ? "أُغلقت تلقائياً" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">لا توجد جلسات في آخر 7 أيام.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run src/components/MyHistory.test.jsx
```

Expected: 3 tests pass.

- [ ] **Step 10: Render it on the employee screen**

In `web/src/components/EmployeeScreen.jsx`, add the import at the top:

```js
import MyHistory from "./MyHistory.jsx";
```

Then render it inside the returned `<div className="grid emp">`, directly after the
closing `</section>` of the "ساعاتي هذا الأسبوع" panel and before the `{error && ...}`
line:

```jsx
      <MyHistory api={api} />
```

- [ ] **Step 11: Run the full frontend suite**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run
```

Expected: all tests pass (42 total). If `EmployeeScreen.test.jsx` now fails because its
`makeApi` mock does not answer `/me/sessions`, extend that mock to return
`{ sessions: [] }` for paths starting with `/me/sessions`.

- [ ] **Step 12: Commit**

```bash
git add src/server.js web/src/components/MyHistory.jsx web/src/components/MyHistory.test.jsx web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(employee): add own 7-day session history"
```

---

### Task 5: Verify end to end and record the work

**Files:**
- Modify: `docs/PROGRESS.md`
- Modify: `docs/DECISIONS.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing code-facing.

- [ ] **Step 1: Run the whole frontend suite**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock/web && npx vitest run
```

Expected: all tests pass, 0 failed.

- [ ] **Step 2: Run the whole smoke test against the local server**

Run:

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock && BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke
```

Expected: 0 failed.

- [ ] **Step 3: Check the screens by hand**

Open `http://localhost:5173`, sign in as employee: the daily target must match whatever
`daily_target_hours` is in the local `settings` row, and "سجلّي — آخر 7 أيام" must
render. Sign in as manager: the report must show an "أيام التأخير" column, and the
settings form must show "سماح التأخير (دقائق)".

- [ ] **Step 4: Append to DECISIONS.md**

Add a dated entry at the top of `docs/DECISIONS.md`, in the file's existing format:

```markdown
### 2026-09-24 — سياسات الدوام تُضبط لكل حساب، لا تُفرض على الجميع
`work_start` + `late_grace_minutes` يحسبان التأخير، والهدف اليومي يُقرأ من إعدادات
الحساب بدل رقم ثابت بالواجهة.
- **السبب:** الأداة منتج لعدة شركات باختلاف أنماط عملها؛ ما يناسب فريقاً مكتبياً لا
  يناسب فريقاً عن بُعد. جعل السياسة إعداداً يغطي الجميع بنواة واحدة.
- **المرفوض:** التتبع التلقائي بالنشاط (يقيس فتح التبويب لا العمل)، وGPS/Geofence
  (كلفة خصوصية بلا فائدة لفرق مكتبية ومبيعات).
```

- [ ] **Step 5: Update PROGRESS.md**

Rewrite the "Current State" section to note that phase 1 of the attendance policies
shipped, and add a Session Log entry at the top in the existing format, naming the
files touched and the commits.

- [ ] **Step 6: Commit**

```bash
git add docs/PROGRESS.md docs/DECISIONS.md
git commit -m "docs: record attendance policies phase 1"
```

- [ ] **Step 7: Apply the migration to production, then deploy**

**Order matters.** First run the `ALTER TABLE` from Task 1 Step 2 against the live
database via hPanel → phpMyAdmin:

```sql
ALTER TABLE settings ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 15 AFTER work_start;
```

Only after that succeeds:

```bash
git push origin main
```

Then verify:

```bash
curl -s https://timeclock.noursky.com/health
```

Expected: `{"ok":true,...}`. Open "الدوام" from GHL and confirm the manager report shows
the new column.

---

## Self-Review

**Spec coverage.** §5.2 daily target → Task 2. §5.1 lateness → Tasks 1 and 3. §5.3
employee history → Task 4. §4 `late_grace_minutes` setting → Task 1 (backend) and
Task 3 (UI). §6 migration order → Task 1 Step 2 locally, Task 5 Step 7 in production.
§7 API changes → Tasks 2, 3, 4. §8 testing → every task ends in tests; the smoke test
gains six checks. Phase-2 items (§5.4, §5.5) are deliberately absent.

**Placeholders.** None: every code step carries the literal code, every run step carries
the literal command and the expected result.

**Type consistency.** `late_grace_minutes` is an integer count of minutes everywhere —
column, API field, form input, and `graceSec` conversion. `late_days` is a number in
both the SQL alias and the React cell. `work_start` is `string|null` in the settings
row, the `/me/settings` payload, and the report payload, and its NULL case is handled
in the SQL (`:lateAfter IS NOT NULL`) and in the UI (`—`).

**Known risk.** The `late_days` expression uses a correlated subquery to find each day's
first session. It is correct on both MySQL 8 and MariaDB 10.2+, but it is the most
complex SQL in the codebase. If Task 3 Step 4 fails on the real database, compute
lateness in JavaScript from `GET /admin/sessions` rows instead — same output, simpler
SQL, slightly more data over the wire.
