# Early-leave Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a company turns it on, an employee can end the shift before today's work end only through a manager-approved request; every request and answer is kept and readable by both sides.

**Architecture:** A pure rule (`earlyLeaveRequired`, `workEndAt`) in `src/activity.js`; a new table `early_leave_requests` (migration 007) and new routes in `src/server.js` (employee request/cancel/list, manager list/approve/reject, a guard in `/session/stop`, lazy expiry inside `autoCloseStale`). On the web: a request dialog and banners on the employee screen, a "طلباتي" list, a manager panel with pending + history tabs, a settings checkbox and a report label.

**Tech Stack:** Node 20 ESM + Hono + mysql2 (named placeholders), MySQL 8 / MariaDB 10.2+; React 18 + Vite, Vitest + RTL; node:test; smoke test `scripts/smoke-test.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-07-early-leave-approval-design.md`

## Global Constraints

- SQL must run on MySQL 8 **and** MariaDB 10.2+: no partial indexes, no `UPDATE … RETURNING`, no `INSERT … AS alias`; generated flags are numeric (`IF(…, 1, NULL)`).
- `location_id` / `user_id` always from `c.get("claims")`, never from the body or query.
- Every `/admin/*` route uses `authed, managerOnly`.
- Errors are `{ error: "CODE" }` via `HttpError`; new codes are listed in `PROJECT.md` §8.
- All timestamps UNIX seconds (UTC); timezone only for display and the work-end rule.
- All user-visible text comes from `web/src/locales/ar.js` and `en.js` (same keys; no Arabic in `en.js`; no Arabic text in component files — `web/src/i18n.test.jsx` scans them). Western digits; logical CSS.
- Reason and manager note: max **300** characters after trim. Reason required; manager note optional.
- The setting `early_leave_approval` is **off by default**; a PUT without the field keeps the stored value.
- On approval the session ends **at the approval moment**, `closed_by = 'approved'`, `note = reason`, an open break ends at the same instant.
- One pending request per session (DB unique key + `409 EARLY_LEAVE_PENDING`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Local DB for tests: Docker container `timeclock-db`; run the API with `node --env-file=.env src/server.js`; smoke with `BASE_URL=http://localhost:3000 node --env-file=.env scripts/smoke-test.mjs`.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/007_early_leave.sql` (new) | settings flag, `closed_by` value, requests table |
| `schema.sql` | same three changes for fresh databases |
| `migrations/README.md` | "Applied" row placeholder for 007 (owner fills the date) |
| `src/activity.js` | `workEndAt(st, ts)`, `earlyLeaveRequired(st, ts)` (pure) |
| `src/activity.test.mjs` | unit tests for both |
| `src/server.js` | settings flag, stop guard, `/me/early-leave*`, `/admin/early-leave*`, `expireEarlyLeave`, `early_leave` in `/me/status` |
| `scripts/smoke-test.mjs` | end-to-end checks; cleanup includes the new table |
| `web/src/components/EarlyLeaveDialog.jsx` (new) | employee request dialog (required reason) |
| `web/src/components/MyEarlyLeave.jsx` (new) | employee's "طلباتي" list |
| `web/src/components/EarlyLeavePanel.jsx` (new) | manager pending + history tabs, approve/reject |
| `web/src/components/EmployeeScreen.jsx` | opens the dialog, pending/rejected/approved banners, disables end while pending |
| `web/src/components/ManagerDashboard.jsx` | mounts `EarlyLeavePanel` first |
| `web/src/components/SettingsPanel.jsx` | checkbox + hint + payload |
| `web/src/components/ReportPanel.jsx` | `closed_by = approved` label |
| `web/src/alertTitle.js` | counter so two panels can mark the title at once |
| `web/src/locales/ar.js`, `en.js` | all new strings |
| `PROJECT.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`, `CLAUDE.md` | API, error codes, log, decision, folder list |

---

### Task 1: Data and the work-end rule

**Files:**
- Create: `migrations/007_early_leave.sql`
- Modify: `schema.sql` (settings, sessions, new table), `migrations/README.md`, `src/activity.js`, `src/activity.test.mjs`, `scripts/smoke-test.mjs:104` (cleanup table list)

**Interfaces:**
- Produces: `workEndAt(st, ts) -> number|null` (today's work end in the location timezone as UNIX seconds; null when `work_start`/`work_end` missing or `work_start >= work_end`); `earlyLeaveRequired(st, ts) -> boolean` (true when `st.early_leave_approval` is truthy, work hours set, today is a working day per `work_days`, and `ts < workEndAt(st, ts)`). Table `early_leave_requests` with columns `id, location_id, user_id, session_id, reason, requested_at, work_end_at, status, decided_by, decided_at, manager_note, pending_flag`.

- [ ] **Step 1: Write the failing unit tests** — append to `src/activity.test.mjs` and add `workEndAt, earlyLeaveRequired` to the import list at the top:

```js
test("workEndAt: today's work end in the location's timezone, null without hours", () => {
  // Monday 2026-10-05, 17:00 Dubai = 13:00Z.
  assert.equal(workEndAt(DUBAI, utc(2026, 9, 5, 8, 0)), utc(2026, 9, 5, 13, 0));
  assert.equal(workEndAt({ ...DUBAI, work_end: null }, utc(2026, 9, 5, 8, 0)), null);
  assert.equal(workEndAt({ ...DUBAI, work_start: "18:00" }, utc(2026, 9, 5, 8, 0)), null);
});

test("earlyLeaveRequired: on, a working day, before work end", () => {
  const on = { ...DUBAI, early_leave_approval: true };
  assert.equal(earlyLeaveRequired(on, utc(2026, 9, 5, 12, 59, 59)), true);   // 16:59:59 Dubai
  assert.equal(earlyLeaveRequired(on, utc(2026, 9, 5, 13, 0, 0)), false);    // 17:00 Dubai
  assert.equal(earlyLeaveRequired(on, utc(2026, 9, 5, 3, 0)), true);         // 07:00, before work start
  assert.equal(earlyLeaveRequired(DUBAI, utc(2026, 9, 5, 8, 0)), false);     // setting off
  assert.equal(earlyLeaveRequired({ ...on, work_end: null }, utc(2026, 9, 5, 8, 0)), false);
  // Monday off (bit 1 cleared): no approval needed.
  assert.equal(earlyLeaveRequired({ ...on, work_days: ALL_DAYS & ~2 }, utc(2026, 9, 5, 8, 0)), false);
});

test("earlyLeaveRequired uses the location's day (Damascus vs UTC)", () => {
  const dam = { timezone: "Asia/Damascus", work_start: "09:00", work_end: "17:00", work_days: ALL_DAYS, early_leave_approval: true };
  // 2026-10-05 13:30Z is 16:30 in Damascus (UTC+3): still before 17:00.
  assert.equal(earlyLeaveRequired(dam, utc(2026, 9, 5, 13, 30)), true);
  // 14:00Z is 17:00 Damascus: over.
  assert.equal(earlyLeaveRequired(dam, utc(2026, 9, 5, 14, 0)), false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run test:unit`
Expected: FAIL — `workEndAt is not a function` / `earlyLeaveRequired is not a function`.

- [ ] **Step 3: Implement in `src/activity.js`** (after `isWithinWorkHours`):

```js
/** Today's work end (UNIX seconds) in the location's timezone, or null when hours are not set. */
export function workEndAt(st, ts) {
  if (!st?.work_start || !st?.work_end || st.work_start >= st.work_end) return null;
  const tz = st.timezone || "Asia/Riyadh";
  return wallToUtc(tz, localDate(tz, ts), st.work_end);
}

/**
 * Early-leave rule (spec 2026-10-07 §2): ending the shift needs a manager's approval when the
 * company turned it on, work hours are set, today is a working day and it is before today's
 * work end. Before work start counts as before work end.
 */
export function earlyLeaveRequired(st, ts) {
  if (!st?.early_leave_approval) return false;
  const end = workEndAt(st, ts);
  if (end == null) return false;
  const days = st.work_days == null ? ALL_DAYS : Number(st.work_days);
  if (!(days & (1 << localWeekday(st.timezone || "Asia/Riyadh", ts)))) return false;
  return ts < end;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npm run test:unit`
Expected: PASS (all, including the 3 new).

- [ ] **Step 5: Write the migration** `migrations/007_early_leave.sql`:

```sql
-- 007 · Early-leave approval (spec 2026-10-07). Apply BEFORE deploying the code that uses it:
-- /session/stop and the settings read the new column. Old code ignores all three changes.
-- Portable across MySQL 8 and MariaDB 10.2+. Several statements: if one fails, check what exists
-- (SHOW COLUMNS FROM settings LIKE 'early_leave%'; SHOW TABLES LIKE 'early_leave%';) and run the rest.
ALTER TABLE settings
  ADD COLUMN early_leave_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER note_on_stop;
ALTER TABLE sessions
  MODIFY closed_by ENUM('user','auto','admin','approved') NULL;
CREATE TABLE IF NOT EXISTS early_leave_requests (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  location_id   VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(64)  NOT NULL,
  session_id    CHAR(36)     NOT NULL,
  reason        VARCHAR(300) NOT NULL,
  requested_at  BIGINT       NOT NULL,
  work_end_at   BIGINT       NOT NULL,
  status        ENUM('pending','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'pending',
  decided_by    VARCHAR(64)  NULL,
  decided_at    BIGINT       NULL,
  manager_note  VARCHAR(300) NULL,
  pending_flag  TINYINT GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED,
  UNIQUE KEY ux_early_leave_pending (session_id, pending_flag),
  KEY ix_early_leave_loc_time (location_id, requested_at),
  KEY ix_early_leave_user_time (location_id, user_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 6: Mirror it in `schema.sql`**
  - In `settings`, after the `note_on_stop` line add:
    `  early_leave_approval TINYINT(1)   NOT NULL DEFAULT 0,  -- ending before work_end needs a manager's approval`
  - In `sessions` change `closed_by    ENUM('user','auto','admin') NULL,` to
    `closed_by    ENUM('user','auto','admin','approved') NULL,`
  - Append the whole `CREATE TABLE IF NOT EXISTS early_leave_requests (…)` block from Step 5 at the end of the file, with the comment `-- One pending request per session; rows are never deleted (spec 2026-10-07).`

- [ ] **Step 7: Record it in `migrations/README.md`** — add a row to the "Applied" table:
  `| \`007_early_leave.sql\` | (pending) | run manually in phpMyAdmin before the early-leave deploy |`

- [ ] **Step 8: Add the table to the smoke cleanup** — in `scripts/smoke-test.mjs` `cleanupLocation`, change the list to
  `["early_leave_requests", "activity_events", "activity_alerts", "ghl_installs", "breaks", "edits_log", "sessions", "employees", "settings"]`.

- [ ] **Step 9: Apply 007 to the local database**

Run (Docker must be running; `open -a Docker` and `docker start timeclock-db` if not):
```bash
node --env-file=.env -e '
const m=(await import("mysql2/promise")).default;const fs=await import("node:fs");
const c=await m.createConnection({host:process.env.DB_HOST,port:+process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,multipleStatements:true});
await c.query(fs.readFileSync("migrations/007_early_leave.sql","utf8"));
console.log((await c.query("SHOW COLUMNS FROM settings LIKE \"early_leave_approval\""))[0].length, (await c.query("SHOW TABLES LIKE \"early_leave_requests\""))[0].length);await c.end();' --input-type=module
```
Expected: `1 1`.

- [ ] **Step 10: Commit**

```bash
git add migrations/007_early_leave.sql migrations/README.md schema.sql src/activity.js src/activity.test.mjs scripts/smoke-test.mjs
git commit -m "feat(early-leave): table, setting and the work-end rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server — setting, stop guard, employee requests, expiry

**Files:**
- Modify: `src/server.js` (imports; `getSettings`; `autoCloseStale`; `/me/status`; `/session/stop`; new `/me/early-leave` routes; `PUT /admin/settings`; 60 s timer)
- Test: `scripts/smoke-test.mjs` (new block before the final `console.log(\`\n${passed} passed…\`)`)

**Interfaces:**
- Consumes: `workEndAt`, `earlyLeaveRequired` from `./activity.js` (Task 1).
- Produces (used by Task 3/4 and the web):
  - `GET /me/status` → adds `early_leave: { required: boolean, work_end_at: number|null, timezone: string, pending: Request|null, last: Request|null }`.
  - `Request` JSON: `{ id, user_id, session_id, reason, requested_at, work_end_at, status, decided_by, decided_at, manager_note, name, decided_by_name }` (numbers for times; `decided_at`/`decided_by`/`manager_note`/`decided_by_name` may be null).
  - `POST /session/stop` → `409 EARLY_LEAVE_NEEDS_APPROVAL` while required.
  - `POST /me/early-leave {reason}` → `201 Request` · errors `409 NO_OPEN_SESSION`, `409 EARLY_LEAVE_NOT_REQUIRED`, `400 REASON_REQUIRED`, `400 REASON_TOO_LONG`, `409 EARLY_LEAVE_PENDING`.
  - `POST /me/early-leave/:id/cancel` → `{ ok: true }` · `404 REQUEST_NOT_FOUND`.
  - `GET /me/early-leave?days=30` → `{ requests: Request[], timezone }` · `400 INVALID_DAYS` outside 1–90.
  - Server helpers `EARLY_LEAVE_SELECT` (SQL prefix), `earlyLeaveRow(row)`, `expireEarlyLeave(loc = null)`.
  - Settings JSON gains `early_leave_approval: boolean`.

- [ ] **Step 1: Write the failing smoke block** — insert before the final summary line of `scripts/smoke-test.mjs`:

```js
// --- Early-leave approval (spec 2026-10-07). Own location; UTC with work hours 00:00–23:59.
const ELLOC = `${LOC}-el`;
const elMgr = await sso({ userId: `${ELLOC}-m1`, role: "admin", type: "account", activeLocation: ELLOC, userName: "مدير الإنهاء", email: "elm@x.com" });
const elEmp = await sso({ userId: `${ELLOC}-u1`, role: "user", type: "account", activeLocation: ELLOC, userName: "موظف الإنهاء", email: "ele@x.com" });
const ELM = elMgr.body?.token, ELE = elEmp.body?.token;
const elNowH = new Date().getUTCHours(), elNowM = new Date().getUTCMinutes();
if (elNowH === 23 && elNowM >= 57) {
  console.log("  SKIP  early-leave checks (too close to 23:59 UTC)");
} else {
  check("the early-leave setting is off by default",
    (await call(ELM, "GET", "/admin/settings")).body?.early_leave_approval === false);
  const elSet = await call(ELM, "PUT", "/admin/settings",
    { timezone: "UTC", work_start: "00:00", work_end: "23:59", work_days: 127, early_leave_approval: true, break_mode: "flexible" });
  check("the early-leave setting is saved", elSet.body?.early_leave_approval === true, `(${elSet.status} ${JSON.stringify(elSet.body?.error)})`);
  check("a settings save without the field keeps it",
    (await call(ELM, "PUT", "/admin/settings", { timezone: "UTC" })).body?.early_leave_approval === true);
  check("a non-boolean early-leave setting → 400",
    (await call(ELM, "PUT", "/admin/settings", { early_leave_approval: "yes" })).body?.error === "INVALID_EARLY_LEAVE");

  check("a request without a session → 409",
    (await call(ELE, "POST", "/me/early-leave", { reason: "موعد" })).body?.error === "NO_OPEN_SESSION");
  await call(ELE, "POST", "/session/start");
  const elSt0 = (await call(ELE, "GET", "/me/status")).body?.early_leave;
  check("status says approval is required before work end",
    elSt0?.required === true && elSt0?.pending === null && elSt0?.timezone === "UTC" && Number.isInteger(elSt0?.work_end_at), `(${JSON.stringify(elSt0)})`);
  check("clocking out before work end needs approval",
    (await call(ELE, "POST", "/session/stop")).body?.error === "EARLY_LEAVE_NEEDS_APPROVAL");
  check("a request without a reason → 400",
    (await call(ELE, "POST", "/me/early-leave", { reason: "   " })).body?.error === "REASON_REQUIRED");
  check("a reason over 300 characters → 400",
    (await call(ELE, "POST", "/me/early-leave", { reason: "x".repeat(301) })).body?.error === "REASON_TOO_LONG");
  const elR1 = await call(ELE, "POST", "/me/early-leave", { reason: "موعد عند الطبيب" });
  check("a request is created pending", elR1.status === 201 && elR1.body?.status === "pending" && elR1.body?.reason === "موعد عند الطبيب",
    `(${elR1.status} ${JSON.stringify(elR1.body)})`);
  check("only one pending request at a time",
    (await call(ELE, "POST", "/me/early-leave", { reason: "تاني" })).body?.error === "EARLY_LEAVE_PENDING");
  check("status carries the pending request",
    (await call(ELE, "GET", "/me/status")).body?.early_leave?.pending?.id === elR1.body?.id);
  check("the employee cancels a pending request",
    (await call(ELE, "POST", `/me/early-leave/${elR1.body?.id}/cancel`)).status === 200);
  check("cancelling again → 404",
    (await call(ELE, "POST", `/me/early-leave/${elR1.body?.id}/cancel`)).body?.error === "REQUEST_NOT_FOUND");
  const elMine = (await call(ELE, "GET", "/me/early-leave?days=30")).body?.requests ?? [];
  check("the employee's history keeps the cancelled request",
    elMine.length === 1 && elMine[0].status === "cancelled" && elMine[0].decided_at != null, `(${JSON.stringify(elMine)})`);
  check("history days outside 1–90 → 400",
    (await call(ELE, "GET", "/me/early-leave?days=91")).body?.error === "INVALID_DAYS");

  // Expiry at work end and on auto-close (local DB only). The pause keeps decision times in
  // different seconds, so "newest decided" is unambiguous.
  await sleep(1100);
  const elR2 = await call(ELE, "POST", "/me/early-leave", { reason: "سبب تاني" });
  const elBack = await localRows("UPDATE early_leave_requests SET work_end_at = :t WHERE id = :id",
    { t: Math.floor(Date.now() / 1000) - 1, id: elR2.body?.id });
  if (elBack === null) {
    console.log("  SKIP  early-leave expiry checks (no local DB)");
  } else {
    const elSt1 = (await call(ELE, "GET", "/me/status")).body?.early_leave;
    check("a pending request expires at work end",
      elSt1?.pending === null && elSt1?.last?.id === elR2.body?.id && elSt1?.last?.status === "expired", `(${JSON.stringify(elSt1)})`);
    const elR3 = await call(ELE, "POST", "/me/early-leave", { reason: "سبب تالت" });
    await localRows("UPDATE sessions SET started_at = :s WHERE location_id = :loc AND ended_at IS NULL",
      { s: Math.floor(Date.now() / 1000) - 13 * 3600, loc: ELLOC });
    const elSt2 = await call(ELE, "GET", "/me/status");
    const elR3Row = ((await call(ELE, "GET", "/me/early-leave")).body?.requests ?? []).find((r) => r.id === elR3.body?.id);
    check("a pending request expires when the session auto-closes",
      elSt2.body?.open_session === null && elR3Row?.status === "expired", `(${JSON.stringify(elR3Row)})`);
  }

  // After work end: no approval needed (work hours 00:00–00:01).
  if (elNowH === 0 && elNowM < 2) {
    console.log("  SKIP  after-work-end checks (too close to 00:01 UTC)");
  } else {
    await call(ELM, "PUT", "/admin/settings", { work_end: "00:01" });
    await call(ELE, "POST", "/session/start");
    check("after work end a request is not needed",
      (await call(ELE, "POST", "/me/early-leave", { reason: "x" })).body?.error === "EARLY_LEAVE_NOT_REQUIRED");
    check("after work end the employee clocks out alone", (await call(ELE, "POST", "/session/stop")).status === 200);
    await call(ELM, "PUT", "/admin/settings", { work_end: "23:59" });
  }
}
await cleanupLocation(ELLOC);
```

- [ ] **Step 2: Run the smoke test to see the block fail**

Run (API running on :3000 with the current code): `BASE_URL=http://localhost:3000 node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|passed"`
Expected: several `FAIL` lines in the early-leave block (e.g. "the early-leave setting is off by default"); every older check still PASS.

- [ ] **Step 3: Implement in `src/server.js`**

(a) Import: change the activity import to
`import { isWithinWorkHours, isFreshEvent, idleSeconds, sessionSummary, idleAlertAt, isLateActivity, workEndAt, earlyLeaveRequired } from "./activity.js";`

(b) `getSettings` — add `early_leave_approval: Boolean(st.early_leave_approval),` next to `activity_monitoring`.

(c) Helpers — add right after `closeIdleOnEndedSessions` (before `/* App */`):

```js
/* ---------- Early leave (spec 2026-10-07) ---------- */
const EARLY_LEAVE_TEXT_MAX = 300;
const EARLY_LEAVE_SELECT = `SELECT r.id, r.user_id, r.session_id, r.reason, r.requested_at, r.work_end_at, r.status,
       r.decided_by, r.decided_at, r.manager_note, e.name, d.name AS decided_by_name
  FROM early_leave_requests r
  LEFT JOIN employees e ON e.user_id = r.user_id AND e.location_id = r.location_id
  LEFT JOIN employees d ON d.user_id = r.decided_by AND d.location_id = r.location_id`;

function earlyLeaveRow(r) {
  return {
    ...r,
    requested_at: Number(r.requested_at),
    work_end_at: Number(r.work_end_at),
    decided_at: r.decided_at == null ? null : Number(r.decided_at),
  };
}

/**
 * A pending request closes as `expired` once today's work end passed or its session ended
 * another way (stop after work end, auto-close, a manager edit). Runs inside autoCloseStale —
 * so before every read — and on the 60 s timer.
 */
async function expireEarlyLeave(loc = null) {
  await q(
    `UPDATE early_leave_requests r LEFT JOIN sessions s ON s.id = r.session_id
        SET r.status = 'expired', r.decided_at = :t
      WHERE r.status = 'pending' AND (r.work_end_at <= :t OR s.id IS NULL OR s.ended_at IS NOT NULL)
        AND (:loc IS NULL OR r.location_id = :loc)`,
    { t: now(), loc }
  );
}
```

(d) `autoCloseStale` — as its last line add:
`  await expireEarlyLeave(loc).catch((e) => console.error("[early-leave-expire]", e));`

(e) Timer — next to the idle timer near the end of the file add:
`setInterval(() => expireEarlyLeave().catch((e) => console.error("[early-leave-expire]", e)), 60 * 1000);`

(f) `/me/status` — before its `return c.json({`, add:

```js
  const [pendingReq] = open.length
    ? await q(`${EARLY_LEAVE_SELECT} WHERE r.session_id = :sid AND r.status = 'pending'`, { sid: open[0].id })
    : [];
  const [lastReq] = await q(
    `${EARLY_LEAVE_SELECT}
      WHERE r.location_id = :loc AND r.user_id = :uid AND r.status <> 'pending' AND r.decided_at >= :dayStart
      ORDER BY r.decided_at DESC, r.requested_at DESC LIMIT 1`,
    { loc, uid, dayStart }
  );
```
and inside the returned object add:
```js
    early_leave: {
      required: earlyLeaveRequired(st, t),
      work_end_at: workEndAt(st, t),
      timezone: st?.timezone ?? "Asia/Riyadh",
      pending: pendingReq ? earlyLeaveRow(pendingReq) : null,
      last: lastReq ? earlyLeaveRow(lastReq) : null,
    },
```

(g) `/session/stop` — replace
`  const policy = (await getSettings(loc))?.note_on_stop ?? "off";`
with
```js
  const st = await getSettings(loc);
  const policy = st?.note_on_stop ?? "off";
```
and right after `if (!rows.length) throw new HttpError(409, "NO_OPEN_SESSION");` add
```js
    // Before work end with the setting on, only an approved request ends the shift.
    if (earlyLeaveRequired(st, now())) throw new HttpError(409, "EARLY_LEAVE_NEEDS_APPROVAL");
```

(h) Employee routes — add after the `/me/alerts/:id/note` route:

```js
app.post("/me/early-leave", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const b = (await c.req.json().catch(() => null)) ?? {};
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  const st = await getSettings(loc);
  const t = now();
  const [s] = await q(
    "SELECT id FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL",
    { uid, loc }
  );
  if (!s) throw new HttpError(409, "NO_OPEN_SESSION");
  if (!earlyLeaveRequired(st, t)) throw new HttpError(409, "EARLY_LEAVE_NOT_REQUIRED");
  if (!reason) throw new HttpError(400, "REASON_REQUIRED");
  if (reason.length > EARLY_LEAVE_TEXT_MAX) throw new HttpError(400, "REASON_TOO_LONG");
  const id = randomUUID();
  try {
    await q(
      `INSERT INTO early_leave_requests (id, location_id, user_id, session_id, reason, requested_at, work_end_at, status)
       VALUES (:id, :loc, :uid, :sid, :reason, :t, :end, 'pending')`,
      { id, loc, uid, sid: s.id, reason, t, end: workEndAt(st, t) }
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "EARLY_LEAVE_PENDING");
    throw e;
  }
  const [row] = await q(`${EARLY_LEAVE_SELECT} WHERE r.id = :id`, { id });
  return c.json(earlyLeaveRow(row), 201);
});

app.post("/me/early-leave/:id/cancel", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  const r = await q(
    `UPDATE early_leave_requests SET status = 'cancelled', decided_at = :t
      WHERE id = :id AND location_id = :loc AND user_id = :uid AND status = 'pending'`,
    { t: now(), id: c.req.param("id"), loc, uid }
  );
  if (!r.affectedRows) throw new HttpError(404, "REQUEST_NOT_FOUND");
  return c.json({ ok: true });
});

app.get("/me/early-leave", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const days = intParam(c, "days", 30);
  if (days < 1 || days > 90) throw new HttpError(400, "INVALID_DAYS");
  const rows = await q(
    `${EARLY_LEAVE_SELECT}
      WHERE r.location_id = :loc AND r.user_id = :uid AND r.requested_at >= :from
      ORDER BY r.requested_at DESC, r.id DESC`,
    { loc, uid, from: now() - days * 86400 }
  );
  const st = await getSettings(loc);
  return c.json({ requests: rows.map(earlyLeaveRow), timezone: st?.timezone ?? "Asia/Riyadh" });
});
```

(i) `PUT /admin/settings` — after the `idleMinutes` validation add:
```js
  if (has("early_leave_approval") && typeof b.early_leave_approval !== "boolean") {
    throw new HttpError(400, "INVALID_EARLY_LEAVE");
  }
  const earlyLeave = has("early_leave_approval") ? b.early_leave_approval : Boolean(cur.early_leave_approval);
```
In the `UPDATE settings SET …` statement add `early_leave_approval = :earlyLeave,` before `note_on_stop = :notePolicy`, and add `earlyLeave: earlyLeave ? 1 : 0,` to the params object.

- [ ] **Step 4: Restart the API and run the tests**

Run: stop the API (`kill $(lsof -tiTCP:3000 -sTCP:LISTEN)`), start it again (`node --env-file=.env src/server.js` in the background), then
`BASE_URL=http://localhost:3000 node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|passed"` and `npm run test:unit`.
Expected: `0 failed` in both; the early-leave checks PASS (or SKIP near midnight UTC).

- [ ] **Step 5: Document the API** in `PROJECT.md` §8:
  - Employee table: rows for `POST /me/early-leave`, `POST /me/early-leave/:id/cancel`, `GET /me/early-leave`, and `/me/status` gains `early_leave` (fields as in Interfaces).
  - `POST /session/stop` row: add `409 EARLY_LEAVE_NEEDS_APPROVAL`.
  - Error table rows: `EARLY_LEAVE_NEEDS_APPROVAL` 409, `EARLY_LEAVE_NOT_REQUIRED` 409, `EARLY_LEAVE_PENDING` 409, `REASON_TOO_LONG` 400, `REQUEST_NOT_FOUND` 404, `INVALID_EARLY_LEAVE` 400 (Arabic meaning column like the others).

- [ ] **Step 6: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(early-leave): stop guard, employee requests and expiry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Server — manager list, approve, reject

**Files:**
- Modify: `src/server.js` (new `/admin/early-leave*` routes after `/admin/alerts/:id/dismiss`), `scripts/smoke-test.mjs` (extend the early-leave block), `PROJECT.md` §8

**Interfaces:**
- Consumes: `EARLY_LEAVE_SELECT`, `earlyLeaveRow`, `expireEarlyLeave`, `EARLY_LEAVE_TEXT_MAX`, `closeIdleOnEndedSessions`, `summarizeClosedSessions` (Task 2 / existing).
- Produces:
  - `GET /admin/early-leave?status=pending|all&days=30` → `{ requests: Request[], timezone, server_time }` · `400 INVALID_STATUS`, `400 INVALID_DAYS`.
  - `POST /admin/early-leave/:id/approve` → `{ ok: true, session_id, ended_at }` · `404 REQUEST_NOT_FOUND`, `409 REQUEST_EXPIRED`.
  - `POST /admin/early-leave/:id/reject {note?}` → `{ ok: true }` · `400 NOTE_TOO_LONG`, `404 REQUEST_NOT_FOUND`.
  - Sessions ended by approval carry `closed_by: "approved"` everywhere sessions are returned.

- [ ] **Step 1: Extend the smoke block** — inside the early-leave `else { … }`, right after the "history days outside 1–90 → 400" check and **before** the expiry part, insert:

```js
  // Manager: reject, then approve (with an open break), histories.
  const elR4 = await call(ELE, "POST", "/me/early-leave", { reason: "عندي ظرف" });
  const elOther = await sso({ userId: `${ELLOC}-x-m1`, role: "admin", type: "account", activeLocation: `${ELLOC}-x`, userName: "مدير غريب", email: "elx@x.com" });
  check("another location's manager cannot approve",
    (await call(elOther.body?.token, "POST", `/admin/early-leave/${elR4.body?.id}/approve`)).body?.error === "REQUEST_NOT_FOUND");
  check("an employee cannot approve", (await call(ELE, "POST", `/admin/early-leave/${elR4.body?.id}/approve`)).status === 403);
  const elPend = (await call(ELM, "GET", "/admin/early-leave?status=pending")).body?.requests ?? [];
  check("the manager sees the pending request with the name",
    elPend.length === 1 && elPend[0].id === elR4.body?.id && elPend[0].name === "موظف الإنهاء", `(${JSON.stringify(elPend)})`);
  check("a manager note over 300 characters → 400",
    (await call(ELM, "POST", `/admin/early-leave/${elR4.body?.id}/reject`, { note: "x".repeat(301) })).body?.error === "NOTE_TOO_LONG");
  check("the manager rejects with a note",
    (await call(ELM, "POST", `/admin/early-leave/${elR4.body?.id}/reject`, { note: "خلّص الطلبية أول" })).status === 200);
  const elSt3 = (await call(ELE, "GET", "/me/status")).body;
  check("after a rejection the session stays open and the employee sees why",
    elSt3?.open_session != null && elSt3?.early_leave?.pending === null && elSt3?.early_leave?.last?.status === "rejected"
      && elSt3?.early_leave?.last?.manager_note === "خلّص الطلبية أول" && elSt3?.early_leave?.last?.decided_by_name === "مدير الإنهاء",
    `(${JSON.stringify(elSt3?.early_leave)})`);
  await sleep(1100); // the approval below must be decided in a later second than the rejection
  const elR5 = await call(ELE, "POST", "/me/early-leave", { reason: "موعد مستعجل" });
  check("after a rejection a new request can be sent", elR5.status === 201);
  await call(ELE, "POST", "/session/break/start");
  const elApprove = await call(ELM, "POST", `/admin/early-leave/${elR5.body?.id}/approve`);
  check("approval ends the session now", elApprove.status === 200 && Math.abs(elApprove.body?.ended_at - Math.floor(Date.now() / 1000)) <= 5,
    `(${elApprove.status} ${JSON.stringify(elApprove.body)})`);
  check("approving again → 404",
    (await call(ELM, "POST", `/admin/early-leave/${elR5.body?.id}/approve`)).body?.error === "REQUEST_NOT_FOUND");
  const elSt4 = (await call(ELE, "GET", "/me/status")).body;
  check("the employee is out and sees the approval",
    elSt4?.open_session === null && elSt4?.open_break === null && elSt4?.early_leave?.last?.status === "approved", `(${JSON.stringify(elSt4?.early_leave)})`);
  const elT = Math.floor(Date.now() / 1000);
  const elSess = ((await call(ELM, "GET", `/admin/sessions?from=${elT - 3600}&to=${elT + 60}&user_id=${ELLOC}-u1`)).body?.sessions ?? [])
    .find((x) => x.id === elApprove.body?.session_id);
  check("the approved session says so and keeps the reason as its note",
    elSess?.closed_by === "approved" && elSess?.note === "موعد مستعجل" && elSess?.ended_at === elApprove.body?.ended_at, `(${JSON.stringify(elSess)})`);
  const elAll = (await call(ELM, "GET", "/admin/early-leave?status=all&days=30")).body?.requests ?? [];
  check("the manager's history keeps every request, newest first",
    elAll.map((r) => r.status).sort().join(",") === "approved,cancelled,rejected"
      && elAll.every((r, i) => i === 0 || elAll[i - 1].requested_at >= r.requested_at),
    `(${elAll.map((r) => r.status).join(",")})`);
  check("an unknown status filter → 400",
    (await call(ELM, "GET", "/admin/early-leave?status=open")).body?.error === "INVALID_STATUS");
  await call(ELE, "POST", "/session/start"); // the expiry part below needs an open session
```

- [ ] **Step 2: Run it to see the new checks fail**

Run: `BASE_URL=http://localhost:3000 node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|passed"`
Expected: FAIL on "another location's manager cannot approve" and the following manager checks (404 for unknown routes is `{ error: … }` other than the expected code).

- [ ] **Step 3: Implement the routes** in `src/server.js` after `/admin/alerts/:id/dismiss`:

```js
app.get("/admin/early-leave", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  await autoCloseStale(loc);
  const status = c.req.query("status") ?? "pending";
  if (status !== "pending" && status !== "all") throw new HttpError(400, "INVALID_STATUS");
  const days = intParam(c, "days", 30);
  if (days < 1 || days > 90) throw new HttpError(400, "INVALID_DAYS");
  const pendingOnly = status === "pending" ? 1 : 0;
  const rows = await q(
    `${EARLY_LEAVE_SELECT}
      WHERE r.location_id = :loc AND (:pendingOnly = 0 OR r.status = 'pending')
        AND (:pendingOnly = 1 OR r.requested_at >= :from)
      ORDER BY r.requested_at DESC, r.id DESC`,
    { loc, pendingOnly, from: now() - days * 86400 }
  );
  const st = await getSettings(loc);
  return c.json({ requests: rows.map(earlyLeaveRow), timezone: st?.timezone ?? "Asia/Riyadh", server_time: now() });
});

// Approval ends the session at this moment (spec 2026-10-07 §4): one transaction locks the
// request and its session, ends both, then the same follow-ups as a normal stop run.
app.post("/admin/early-leave/:id/approve", authed, managerOnly, async (c) => {
  const { loc, uid: manager } = c.get("claims");
  const conn = await pool.getConnection();
  let ended = null;
  let expired = false;
  try {
    await conn.beginTransaction();
    const [[req]] = await conn.execute(
      `SELECT id, session_id, reason FROM early_leave_requests
        WHERE id = :id AND location_id = :loc AND status = 'pending' FOR UPDATE`,
      { id: c.req.param("id"), loc }
    );
    if (!req) throw new HttpError(404, "REQUEST_NOT_FOUND");
    const t = now();
    const [[s]] = await conn.execute(
      "SELECT id, started_at, ended_at FROM sessions WHERE id = :sid AND location_id = :loc FOR UPDATE",
      { sid: req.session_id, loc }
    );
    if (!s || s.ended_at != null) {
      await conn.execute(
        "UPDATE early_leave_requests SET status = 'expired', decided_at = :t WHERE id = :id",
        { t, id: req.id }
      );
      expired = true;
    } else {
      await conn.execute(
        `UPDATE sessions SET ended_at = :t, duration_sec = :dur, closed_by = 'approved', note = :note
          WHERE id = :sid`,
        { t, dur: t - Number(s.started_at), note: req.reason, sid: s.id }
      );
      await conn.execute("UPDATE breaks SET ended_at = :t WHERE session_id = :sid AND ended_at IS NULL", { t, sid: s.id });
      await conn.execute(
        "UPDATE early_leave_requests SET status = 'approved', decided_by = :manager, decided_at = :t WHERE id = :id",
        { manager, t, id: req.id }
      );
      ended = { session_id: s.id, ended_at: t };
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
  if (expired) throw new HttpError(409, "REQUEST_EXPIRED");
  await closeIdleOnEndedSessions(loc).catch((e) => console.error("[idle-close]", e));
  await summarizeClosedSessions(loc).catch((e) => console.error("[activity-summary]", e));
  return c.json({ ok: true, ...ended });
});

app.post("/admin/early-leave/:id/reject", authed, managerOnly, async (c) => {
  const { loc, uid: manager } = c.get("claims");
  const b = (await c.req.json().catch(() => null)) ?? {};
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > EARLY_LEAVE_TEXT_MAX) throw new HttpError(400, "NOTE_TOO_LONG");
  await expireEarlyLeave(loc); // a request whose session already ended is no longer pending
  const r = await q(
    `UPDATE early_leave_requests SET status = 'rejected', decided_by = :manager, decided_at = :t, manager_note = :note
      WHERE id = :id AND location_id = :loc AND status = 'pending'`,
    { manager, t: now(), note: note || null, id: c.req.param("id"), loc }
  );
  if (!r.affectedRows) throw new HttpError(404, "REQUEST_NOT_FOUND");
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Restart the API and run all backend tests**

Run: restart the API, then the smoke test and `npm run test:unit`.
Expected: `0 failed` in both.

- [ ] **Step 5: Document** in `PROJECT.md` §8 — manager table rows for the three routes (responses and errors as in Interfaces), error row `REQUEST_EXPIRED` 409, and in the sessions description note that `closed_by` may be `approved`.

- [ ] **Step 6: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(early-leave): manager list, approve and reject

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Employee screen — dialog, banners, "طلباتي"

**Files:**
- Create: `web/src/components/EarlyLeaveDialog.jsx`, `web/src/components/EarlyLeaveDialog.test.jsx`, `web/src/components/MyEarlyLeave.jsx`, `web/src/components/MyEarlyLeave.test.jsx`
- Modify: `web/src/components/EmployeeScreen.jsx`, `web/src/components/EmployeeScreen.test.jsx`, `web/src/locales/ar.js`, `web/src/locales/en.js`

**Interfaces:**
- Consumes: `GET /me/status` `early_leave`, `POST /me/early-leave`, `POST /me/early-leave/:id/cancel`, `GET /me/early-leave?days=30` (Task 2).
- Produces: `EarlyLeaveDialog({ workEnd, loading, error, onSend(reason), onCancel })`; `MyEarlyLeave({ api, reloadKey })`; locale keys under `earlyLeave.*` (both files).

- [ ] **Step 1: Add the strings** — `web/src/locales/ar.js` (inside the object, before the closing brace):

```js
  "earlyLeave.title": "طلب إنهاء الدوام",
  "earlyLeave.hint": "دوامك بينتهي الساعة {time}. لتطلع قبل، لازم موافقة المدير.",
  "earlyLeave.reason": "السبب",
  "earlyLeave.send": "إرسال الطلب",
  "earlyLeave.cancel": "إلغاء",
  "earlyLeave.reasonRequired": "اكتب السبب",
  "earlyLeave.sent": "انبعت طلبك للمدير",
  "earlyLeave.pending": "طلبك لإنهاء الدوام عند المدير (السبب: {reason})",
  "earlyLeave.withdraw": "إلغاء الطلب",
  "earlyLeave.withdrawn": "انلغى الطلب",
  "earlyLeave.rejected": "رفض المدير طلبك الساعة {time}",
  "earlyLeave.rejectedNote": "ملاحظة المدير: {note}",
  "earlyLeave.again": "فيك تبعت طلب جديد",
  "earlyLeave.approved": "وافق المدير، انتهى دوامك الساعة {time}",
  "earlyLeave.mineTitle": "طلباتي",
  "earlyLeave.colDate": "التاريخ",
  "earlyLeave.colReason": "السبب",
  "earlyLeave.colStatus": "الحالة",
  "earlyLeave.colAnswer": "الرد",
  "earlyLeave.status.pending": "معلّق",
  "earlyLeave.status.approved": "موافَق",
  "earlyLeave.status.rejected": "مرفوض",
  "earlyLeave.status.cancelled": "ملغى",
  "earlyLeave.status.expired": "انتهى قبل الرد",
  "earlyLeave.answeredBy": "{name} · {time}",
  "err.REASON_REQUIRED": "اكتب السبب",
  "err.REASON_TOO_LONG": "السبب طويل كتير (300 حرف كحد أقصى)",
  "err.EARLY_LEAVE_PENDING": "عندك طلب معلّق",
  "err.EARLY_LEAVE_NOT_REQUIRED": "خلص وقت الدوام، فيك تنهي عادي",
```
Note: if `err.REASON_REQUIRED` already exists in `ar.js`/`en.js`, keep the existing key and skip the duplicate line.

`web/src/locales/en.js` (same keys):

```js
  "earlyLeave.title": "Request to end the shift",
  "earlyLeave.hint": "Your shift ends at {time}. To leave earlier you need your manager's approval.",
  "earlyLeave.reason": "Reason",
  "earlyLeave.send": "Send request",
  "earlyLeave.cancel": "Cancel",
  "earlyLeave.reasonRequired": "Write the reason",
  "earlyLeave.sent": "Your request was sent to your manager",
  "earlyLeave.pending": "Your request to end the shift is with your manager (reason: {reason})",
  "earlyLeave.withdraw": "Cancel request",
  "earlyLeave.withdrawn": "Request cancelled",
  "earlyLeave.rejected": "Your manager declined your request at {time}",
  "earlyLeave.rejectedNote": "Manager's note: {note}",
  "earlyLeave.again": "You can send a new request",
  "earlyLeave.approved": "Your manager approved; your shift ended at {time}",
  "earlyLeave.mineTitle": "My requests",
  "earlyLeave.colDate": "Date",
  "earlyLeave.colReason": "Reason",
  "earlyLeave.colStatus": "Status",
  "earlyLeave.colAnswer": "Answer",
  "earlyLeave.status.pending": "Pending",
  "earlyLeave.status.approved": "Approved",
  "earlyLeave.status.rejected": "Declined",
  "earlyLeave.status.cancelled": "Cancelled",
  "earlyLeave.status.expired": "Closed without an answer",
  "earlyLeave.answeredBy": "{name} · {time}",
  "err.REASON_REQUIRED": "Write the reason",
  "err.REASON_TOO_LONG": "The reason is too long (300 characters at most)",
  "err.EARLY_LEAVE_PENDING": "You already have a pending request",
  "err.EARLY_LEAVE_NOT_REQUIRED": "The work day is over; you can clock out",
```

- [ ] **Step 2: Write the failing component tests**

`web/src/components/EarlyLeaveDialog.test.jsx`:
```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import EarlyLeaveDialog from "./EarlyLeaveDialog.jsx";

describe("EarlyLeaveDialog", () => {
  it("shows the work end and refuses an empty reason", () => {
    const onSend = vi.fn();
    render(<EarlyLeaveDialog workEnd="18:00" onSend={onSend} onCancel={() => {}} />);
    expect(screen.getByText(/18:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("اكتب السبب")).toBeInTheDocument();
  });

  it("sends the trimmed reason", () => {
    const onSend = vi.fn();
    render(<EarlyLeaveDialog workEnd="18:00" onSend={onSend} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("السبب"), { target: { value: "  موعد  " } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));
    expect(onSend).toHaveBeenCalledWith("موعد");
  });
});
```

`web/src/components/MyEarlyLeave.test.jsx`:
```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MyEarlyLeave from "./MyEarlyLeave.jsx";

const at = Date.UTC(2026, 9, 7, 12, 0) / 1000;

describe("MyEarlyLeave", () => {
  it("renders nothing without requests", async () => {
    const api = { get: vi.fn(async () => ({ requests: [], timezone: "UTC" })) };
    const { container } = render(<MyEarlyLeave api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/early-leave?days=30"));
    expect(container.querySelector(".my-early-leave")).toBeNull();
  });

  it("lists each request with status, reason and the answer", async () => {
    const api = { get: vi.fn(async () => ({ timezone: "UTC", requests: [
      { id: "r1", reason: "موعد", requested_at: at, status: "rejected", decided_at: at + 600, decided_by_name: "سارة", manager_note: "بكرا" },
    ] })) };
    render(<MyEarlyLeave api={api} />);
    expect(await screen.findByText("موعد")).toBeInTheDocument();
    expect(screen.getByText("مرفوض")).toBeInTheDocument();
    expect(screen.getByText("سارة · 12:10")).toBeInTheDocument();
    expect(screen.getByText("بكرا")).toBeInTheDocument();
  });

  it("reloads when its reload key changes", async () => {
    const api = { get: vi.fn(async () => ({ requests: [], timezone: "UTC" })) };
    const { rerender } = render(<MyEarlyLeave api={api} reloadKey={0} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    rerender(<MyEarlyLeave api={api} reloadKey={1} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
```

Add to `web/src/components/EmployeeScreen.test.jsx` (inside the `describe`, using the file's `makeApi`, `withAlerts`, `nowSec`, `wrap`):
```jsx
  const earlyStatus = (early, open = true) => {
    const t = nowSec();
    return { open_session: open ? { id: "s1", started_at: t - 3600, break_sec: 0 } : null, worked_sec: 3600, server_time: t,
      early_leave: { required: true, work_end_at: t + 7200, timezone: "UTC", pending: null, last: null, ...early } };
  };

  it("asks for the manager's approval instead of clocking out before work end", async () => {
    const api = makeApi(earlyStatus({}));
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /إنهاء الدوام/ }));
    fireEvent.change(screen.getByLabelText("السبب"), { target: { value: "موعد" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/me/early-leave", { reason: "موعد" }));
    expect(api.post).not.toHaveBeenCalledWith("/session/stop", expect.anything());
  });

  it("shows a pending request, lets the employee cancel it, and disables ending", async () => {
    const api = makeApi(earlyStatus({ pending: { id: "r1", reason: "موعد", status: "pending" } }));
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText(/السبب: موعد/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /إنهاء الدوام/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "إلغاء الطلب" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/me/early-leave/r1/cancel"));
  });

  it("shows a rejection with the manager's note for the open session", async () => {
    const t = nowSec();
    const api = makeApi(earlyStatus({ last: { id: "r1", session_id: "s1", status: "rejected", decided_at: t, manager_note: "بعد الطلبية" } }));
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText(/رفض المدير طلبك/)).toBeInTheDocument();
    expect(screen.getByText(/بعد الطلبية/)).toBeInTheDocument();
  });

  it("shows the approval once the shift ended", async () => {
    const t = nowSec();
    const api = makeApi(earlyStatus({ required: false, last: { id: "r1", session_id: "s1", status: "approved", decided_at: t } }, false));
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText(/وافق المدير، انتهى دوامك/)).toBeInTheDocument();
  });
```
(`makeApi` answers every unknown GET with the status object; `/me/early-leave?days=30` therefore returns an object without `requests`, which `MyEarlyLeave` must treat as empty.)

- [ ] **Step 3: Run them to see them fail**

Run: `cd web && npx vitest run src/components/EarlyLeaveDialog.test.jsx src/components/MyEarlyLeave.test.jsx src/components/EmployeeScreen.test.jsx`
Expected: FAIL — modules not found / texts not found.

- [ ] **Step 4: Implement `EarlyLeaveDialog.jsx`**

```jsx
import { useState } from "react";
import Button from "./Button.jsx";
import { useI18n } from "../i18n.jsx";

const REASON_MAX = 300;

// Asking the manager to end the shift before work end (spec 2026-10-07 §5). The reason is required.
export default function EarlyLeaveDialog({ workEnd, loading, error, onSend, onCancel }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const shown = missing ? t("earlyLeave.reasonRequired") : error || "";

  function send() {
    const trimmed = reason.trim();
    if (!trimmed) { setMissing(true); return; }
    onSend(trimmed);
  }

  return (
    <div className="overlay">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="early-leave-title"
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
        <h2 id="early-leave-title">{t("earlyLeave.title")}</h2>
        <p className="hint">{t("earlyLeave.hint", { time: workEnd ?? "—" })}</p>
        <div className="field">
          <label htmlFor="early-leave-reason">{t("earlyLeave.reason")}</label>
          <textarea id="early-leave-reason" maxLength={REASON_MAX} value={reason} autoFocus
            aria-invalid={shown ? "true" : undefined} aria-describedby={shown ? "early-leave-err" : undefined}
            onChange={(e) => { setReason(e.target.value); setMissing(false); }} />
          {shown && <span className="err" id="early-leave-err">{shown}</span>}
        </div>
        <div className="dlg-a">
          <Button onClick={send} loading={loading}>{t("earlyLeave.send")}</Button>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>{t("earlyLeave.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `MyEarlyLeave.jsx`**

```jsx
import { useEffect, useState } from "react";
import { formatStamp, formatTime } from "../time.js";
import { useI18n } from "../i18n.jsx";

// The employee's own early-leave requests of the last 30 days (spec 2026-10-07 §5). Hidden
// while there are none; reloads with the employee screen (`reloadKey`).
export default function MyEarlyLeave({ api, reloadKey = 0 }) {
  const { t } = useI18n();
  const [data, setData] = useState({ requests: [], timezone: null });

  useEffect(() => {
    api.get("/me/early-leave?days=30")
      .then((r) => setData({ requests: Array.isArray(r?.requests) ? r.requests : [], timezone: r?.timezone ?? null }))
      .catch(() => {});
  }, [reloadKey]);

  if (!data.requests.length) return null;
  const tz = data.timezone;
  return (
    <section className="panel my-early-leave">
      <div className="panel-h"><h2>{t("earlyLeave.mineTitle")}</h2></div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{t("earlyLeave.colDate")}</th><th>{t("earlyLeave.colReason")}</th>
            <th>{t("earlyLeave.colStatus")}</th><th>{t("earlyLeave.colAnswer")}</th>
          </tr></thead>
          <tbody>
            {data.requests.map((r) => (
              <tr key={r.id}>
                <td className="ltr">{formatStamp(r.requested_at, tz)}</td>
                <td>{r.reason}</td>
                <td>{t(`earlyLeave.status.${r.status}`)}</td>
                <td>
                  {r.decided_by_name && r.decided_at != null && (
                    <div>{t("earlyLeave.answeredBy", { name: r.decided_by_name, time: formatTime(r.decided_at, tz) })}</div>
                  )}
                  {r.manager_note && <div className="muted">{r.manager_note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```
(Check `formatStamp` exists in `web/src/time.js` — `MyHistory.jsx` imports it; same signature `(ts, timeZone)`.)

- [ ] **Step 6: Wire `EmployeeScreen.jsx`**

(a) Imports: `import EarlyLeaveDialog from "./EarlyLeaveDialog.jsx";` and `import MyEarlyLeave from "./MyEarlyLeave.jsx";`.

(b) State next to `askNote`: `const [askEarly, setAskEarly] = useState(false);` and `const [earlyError, setEarlyError] = useState("");`.

(c) In `toggle()`, before the note-policy line:
```js
    if (status?.early_leave?.required) { setEarlyError(""); setAskEarly(true); return undefined; }
```

(d) Add the senders after `stopWithNote`:
```js
  async function sendEarlyLeave(reason) {
    setLoading(true);
    setEarlyError("");
    try {
      await api.post("/me/early-leave", { reason });
      setAskEarly(false);
      toast(t("earlyLeave.sent"));
      await reloadAll().catch(() => {});
    } catch (e) {
      const known = ["REASON_REQUIRED", "REASON_TOO_LONG", "EARLY_LEAVE_PENDING", "EARLY_LEAVE_NOT_REQUIRED"];
      setEarlyError(t(known.includes(e.code) ? `err.${e.code}` : GENERIC_ERROR));
      if (e.code === "EARLY_LEAVE_PENDING" || e.code === "EARLY_LEAVE_NOT_REQUIRED") await reloadAll().catch(() => {});
    } finally {
      setLoading(false);
    }
  }

  async function withdrawEarlyLeave(id) {
    await run(() => api.post(`/me/early-leave/${id}/cancel`), t("earlyLeave.withdrawn"));
  }
```

(e) After the existing `const idle = …` line add:
```js
  const early = status?.early_leave ?? null;
  const earlyPending = open ? early?.pending ?? null : null;
  const earlyRejected = open && early?.last?.status === "rejected" && early.last.session_id === open.id ? early.last : null;
  const earlyApproved = !open && early?.last?.status === "approved" ? early.last : null;
  const earlyTz = early?.timezone ?? null;
```

(f) The clock-out `<Button …>` gets `disabled={Boolean(open && earlyPending)}`.

(g) After the `idle` notice section, add:
```jsx
      {earlyPending && (
        <section className="panel notice" role="status">
          <p>{t("earlyLeave.pending", { reason: earlyPending.reason })}</p>
          <Button variant="ghost" size="sm" onClick={() => withdrawEarlyLeave(earlyPending.id)}>{t("earlyLeave.withdraw")}</Button>
        </section>
      )}
      {earlyRejected && !earlyPending && (
        <section className="panel notice" role="status">
          <p>{t("earlyLeave.rejected", { time: formatTime(earlyRejected.decided_at, earlyTz) })}</p>
          {earlyRejected.manager_note && <p>{t("earlyLeave.rejectedNote", { note: earlyRejected.manager_note })}</p>}
          <p className="hint">{t("earlyLeave.again")}</p>
        </section>
      )}
      {earlyApproved && (
        <section className="panel notice" role="status">
          <p>{t("earlyLeave.approved", { time: formatTime(earlyApproved.decided_at, earlyTz) })}</p>
        </section>
      )}
```

(h) After `<MyHistory api={api} reloadKey={historyKey} />` add `<MyEarlyLeave api={api} reloadKey={historyKey} />`.

(i) Next to the `askNote` dialog render:
```jsx
      {askEarly && (
        <EarlyLeaveDialog workEnd={early?.work_end_at ? formatTime(early.work_end_at, earlyTz) : null}
          loading={loading} error={earlyError}
          onSend={sendEarlyLeave} onCancel={() => { setAskEarly(false); setEarlyError(""); }} />
      )}
```

(j) In `run()`'s error handling add `EARLY_LEAVE_NEEDS_APPROVAL` handling: before the `const mapped = …` line insert
```js
      if (e.code === "EARLY_LEAVE_NEEDS_APPROVAL") {
        // Our copy of the rule was stale (the setting was just turned on): ask instead.
        await reloadAll().catch(() => {});
        setAskEarly(true);
        return false;
      }
```

- [ ] **Step 7: Run all frontend tests**

Run: `cd web && npx vitest run`
Expected: all PASS (including `i18n.test.jsx` key parity and the source scan).

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(early-leave): employee request dialog, banners and my requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Manager panel, settings checkbox, report label, title counter

**Files:**
- Create: `web/src/components/EarlyLeavePanel.jsx`, `web/src/components/EarlyLeavePanel.test.jsx`, `web/src/alertTitle.test.jsx`
- Modify: `web/src/alertTitle.js`, `web/src/components/ManagerDashboard.jsx`, `web/src/components/SettingsPanel.jsx`, `web/src/components/SettingsPanel.test.jsx`, `web/src/components/ReportPanel.jsx`, `web/src/locales/ar.js`, `web/src/locales/en.js`

**Interfaces:**
- Consumes: `GET /admin/early-leave?status=pending`, `GET /admin/early-leave?status=all&days=30`, `POST /admin/early-leave/:id/approve`, `POST /admin/early-leave/:id/reject {note?}` (Task 3); `usePolling(fn, ms)` from `web/src/usePolling.js`; `useAlertTitle(active)`.
- Produces: `EarlyLeavePanel({ api })`; settings payload field `early_leave_approval`; locale keys `earlyLeave.panel*`, `settings.earlyLeave*`, `report.closedBy.approved`.

- [ ] **Step 1: Add the strings** — `ar.js`:
```js
  "earlyLeave.panelTitle": "طلبات الإنهاء المبكر",
  "earlyLeave.tabPending": "المعلّقة",
  "earlyLeave.tabHistory": "السجل",
  "earlyLeave.approve": "موافقة",
  "earlyLeave.reject": "رفض",
  "earlyLeave.rejectNote": "ملاحظة للموظف (اختيارية)",
  "earlyLeave.confirmReject": "تأكيد الرفض",
  "earlyLeave.requestedAt": "طلب الساعة {time}",
  "earlyLeave.approvedToast": "انتهى دوام الموظف بموافقتك",
  "earlyLeave.rejectedToast": "انرفض الطلب",
  "earlyLeave.noPending": "ما في طلبات معلّقة",
  "earlyLeave.noHistory": "ما في طلبات بآخر 30 يوم",
  "earlyLeave.search": "بحث عن موظف",
  "earlyLeave.colEmployee": "الموظف",
  "settings.earlyLeave": "الإنهاء قبل نهاية الدوام بيحتاج موافقة المدير",
  "settings.earlyLeaveHint": "لازم يكون وقت نهاية الدوام محدد",
  "report.closedBy.approved": "بموافقة المدير",
```
`en.js`:
```js
  "earlyLeave.panelTitle": "Early-leave requests",
  "earlyLeave.tabPending": "Pending",
  "earlyLeave.tabHistory": "History",
  "earlyLeave.approve": "Approve",
  "earlyLeave.reject": "Decline",
  "earlyLeave.rejectNote": "Note for the employee (optional)",
  "earlyLeave.confirmReject": "Confirm decline",
  "earlyLeave.requestedAt": "Asked at {time}",
  "earlyLeave.approvedToast": "The employee's shift ended with your approval",
  "earlyLeave.rejectedToast": "Request declined",
  "earlyLeave.noPending": "No pending requests",
  "earlyLeave.noHistory": "No requests in the last 30 days",
  "earlyLeave.search": "Search an employee",
  "earlyLeave.colEmployee": "Employee",
  "settings.earlyLeave": "Ending before the work end needs the manager's approval",
  "settings.earlyLeaveHint": "The work end time must be set",
  "report.closedBy.approved": "Manager approval",
```

- [ ] **Step 2: Make the title mark a counter (failing test first)** — `web/src/alertTitle.test.jsx`:
```jsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useAlertTitle } from "./alertTitle.js";

function Mark({ on }) { useAlertTitle(on); return null; }

describe("useAlertTitle", () => {
  it("keeps the mark while any of two panels still needs it", () => {
    document.title = "TimeClock";
    const a = render(<Mark on />);
    const b = render(<Mark on />);
    expect(document.title).toBe("⚠️ TimeClock");
    a.unmount();
    expect(document.title).toBe("⚠️ TimeClock");
    b.unmount();
    expect(document.title).toBe("TimeClock");
  });
});
```
Run: `cd web && npx vitest run src/alertTitle.test.jsx` → Expected: FAIL (title loses the mark after the first unmount).

Replace `web/src/alertTitle.js` with:
```js
import { useEffect } from "react";

const MARK = "⚠️ ";
const strip = (t) => (t.startsWith(MARK) ? t.slice(MARK.length) : t);
// Several panels can mark the title at once (activity alerts, early-leave requests): the mark
// stays until the last of them lets go.
let holders = 0;

/** Prefixes the tab title with ⚠️ while `active` (spec §12.4) and restores it afterwards. */
export function useAlertTitle(active) {
  useEffect(() => {
    if (!active) return undefined;
    holders += 1;
    document.title = MARK + strip(document.title);
    return () => {
      holders -= 1;
      if (holders === 0) document.title = strip(document.title);
    };
  }, [active]);
}
```
Run the same test → PASS; also `npx vitest run src/components/AlertsPanel.test.jsx src/components/EmployeeScreen.test.jsx` → PASS.

- [ ] **Step 3: Write the failing panel test** — `web/src/components/EarlyLeavePanel.test.jsx`:
```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import EarlyLeavePanel from "./EarlyLeavePanel.jsx";

const at = Date.UTC(2026, 9, 7, 12, 0) / 1000;
const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);
const pendingReq = { id: "r1", user_id: "u1", name: "سارة", reason: "موعد", requested_at: at, status: "pending" };

function makeApi({ pending = [pendingReq], all = [] } = {}) {
  return {
    get: vi.fn(async (p) => (p.startsWith("/admin/early-leave?status=pending")
      ? { requests: pending, timezone: "UTC", server_time: at }
      : { requests: all, timezone: "UTC", server_time: at })),
    post: vi.fn(async () => ({ ok: true })),
  };
}

describe("EarlyLeavePanel", () => {
  it("renders nothing with no pending request and no history", async () => {
    const api = makeApi({ pending: [], all: [] });
    const { container } = wrap(<EarlyLeavePanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector(".early-leave")).toBeNull();
  });

  it("lists a pending request and approves it", async () => {
    const api = makeApi();
    wrap(<EarlyLeavePanel api={api} />);
    expect(await screen.findByText("سارة")).toBeInTheDocument();
    expect(screen.getByText("موعد")).toBeInTheDocument();
    expect(screen.getByText("طلب الساعة 12:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "موافقة" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/early-leave/r1/approve"));
  });

  it("rejects with an optional note", async () => {
    const api = makeApi();
    wrap(<EarlyLeavePanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "رفض" }));
    fireEvent.change(screen.getByLabelText("ملاحظة للموظف (اختيارية)"), { target: { value: "بعد الطلبية" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الرفض" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/early-leave/r1/reject", { note: "بعد الطلبية" }));
  });

  it("shows the history with every field and filters by name", async () => {
    const api = makeApi({ pending: [], all: [
      { ...pendingReq, status: "approved", decided_at: at + 300, decided_by_name: "المدير" },
      { ...pendingReq, id: "r2", user_id: "u2", name: "أحمد", reason: "ظرف", status: "rejected", decided_at: at + 60, decided_by_name: "المدير", manager_note: "لا" },
    ] });
    wrap(<EarlyLeavePanel api={api} />);
    fireEvent.click(await screen.findByRole("tab", { name: "السجل" }));
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(screen.getByText("مرفوض")).toBeInTheDocument();
    expect(screen.getByText("لا")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("بحث عن موظف"), { target: { value: "سارة" } });
    expect(screen.queryByText("أحمد")).toBeNull();
    expect(screen.getByText("موافَق")).toBeInTheDocument();
  });

  it("marks the tab title while a request is pending", async () => {
    document.title = "TimeClock";
    wrap(<EarlyLeavePanel api={makeApi()} />);
    await screen.findByText("سارة");
    expect(document.title).toBe("⚠️ TimeClock");
  });
});
```
Run: `cd web && npx vitest run src/components/EarlyLeavePanel.test.jsx` → Expected: FAIL (module not found).

- [ ] **Step 4: Implement `EarlyLeavePanel.jsx`**

```jsx
import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatStamp, formatTime } from "../time.js";
import { useAlertTitle } from "../alertTitle.js";
import { useI18n } from "../i18n.jsx";
import { usePolling } from "../usePolling.js";

// Early-leave requests for the manager (spec 2026-10-07 §5): pending ones to approve or decline,
// and the history of the last 30 days. Hidden while there is neither.
export default function EarlyLeavePanel({ api }) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState({ pending: [], history: [], timezone: null });
  const [tab, setTab] = useState("pending");
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [p, h] = await Promise.all([
      api.get("/admin/early-leave?status=pending"),
      api.get("/admin/early-leave?status=all&days=30").catch(() => null),
    ]);
    setData({ pending: p.requests ?? [], history: h?.requests ?? [], timezone: p.timezone ?? null });
  }
  useEffect(() => { load().catch(() => {}); }, []);
  usePolling(load, 30000);
  useAlertTitle(data.pending.length > 0);

  async function decide(id, action, body) {
    setBusy(true);
    try {
      await (body ? api.post(`/admin/early-leave/${id}/${action}`, body) : api.post(`/admin/early-leave/${id}/${action}`));
      toast(t(action === "approve" ? "earlyLeave.approvedToast" : "earlyLeave.rejectedToast"));
      setRejecting(null);
      setNote("");
    } catch {
      // Already answered, cancelled or expired elsewhere: the reload below shows the truth.
    } finally {
      setBusy(false);
      await load().catch(() => {});
    }
  }

  if (!data.pending.length && !data.history.length) return null;
  const tz = data.timezone;
  const history = data.history.filter((r) => !query.trim() || (r.name ?? "").includes(query.trim()));

  return (
    <section className="panel alerts early-leave" aria-label={t("earlyLeave.panelTitle")}>
      <div className="panel-h">
        <h2>{t("earlyLeave.panelTitle")}</h2>
        {data.pending.length > 0 && <b className="count">{data.pending.length}</b>}
      </div>
      <div className="seg" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "pending"} onClick={() => setTab("pending")}>{t("earlyLeave.tabPending")}</button>
        <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>{t("earlyLeave.tabHistory")}</button>
      </div>

      {tab === "pending" && (data.pending.length ? data.pending.map((r) => (
        <div className="alert-row" key={r.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{r.name || r.user_id}</div>
            <div className="m">{t("earlyLeave.requestedAt", { time: formatTime(r.requested_at, tz) })}</div>
            <div className="note">{r.reason}</div>
            {rejecting === r.id && (
              <div className="field">
                <label htmlFor={`reject-note-${r.id}`}>{t("earlyLeave.rejectNote")}</label>
                <textarea id={`reject-note-${r.id}`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                <Button variant="danger" size="sm" loading={busy}
                  onClick={() => decide(r.id, "reject", { note: note.trim() })}>{t("earlyLeave.confirmReject")}</Button>
              </div>
            )}
          </div>
          <div className="actions">
            <Button size="sm" loading={busy} onClick={() => decide(r.id, "approve")}>{t("earlyLeave.approve")}</Button>
            <Button variant="ghost" size="sm" disabled={busy}
              onClick={() => { setRejecting(r.id); setNote(""); }}>{t("earlyLeave.reject")}</Button>
          </div>
        </div>
      )) : <p className="muted">{t("earlyLeave.noPending")}</p>)}

      {tab === "history" && (
        <>
          <input type="search" placeholder={t("earlyLeave.search")} aria-label={t("earlyLeave.search")}
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {history.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>{t("earlyLeave.colEmployee")}</th><th>{t("earlyLeave.colDate")}</th>
                  <th>{t("earlyLeave.colReason")}</th><th>{t("earlyLeave.colStatus")}</th><th>{t("earlyLeave.colAnswer")}</th>
                </tr></thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name || r.user_id}</td>
                      <td className="ltr">{formatStamp(r.requested_at, tz)}</td>
                      <td>{r.reason}</td>
                      <td>{t(`earlyLeave.status.${r.status}`)}</td>
                      <td>
                        {r.decided_by_name && r.decided_at != null && (
                          <div>{t("earlyLeave.answeredBy", { name: r.decided_by_name, time: formatTime(r.decided_at, tz) })}</div>
                        )}
                        {r.manager_note && <div className="muted">{r.manager_note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">{t("earlyLeave.noHistory")}</p>}
        </>
      )}
    </section>
  );
}
```
Mount it: in `ManagerDashboard.jsx` add `import EarlyLeavePanel from "./EarlyLeavePanel.jsx";` and render `<EarlyLeavePanel api={api} />` as the first child of the grid (before `<AlertsPanel …>`).

Run: `cd web && npx vitest run src/components/EarlyLeavePanel.test.jsx` → Expected: PASS.

- [ ] **Step 5: Settings checkbox (failing test first)** — add to `web/src/components/SettingsPanel.test.jsx` (reuse the file's existing render helper and api mock; the saved payload is the second argument of the `PUT /admin/settings` call):
```jsx
  it("saves the early-leave approval setting and warns without a work end", async () => {
    const api = {
      get: vi.fn(async (p) => (p === "/admin/settings" ? { ...WH, work_end: null, early_leave_approval: false } : { installed: false })),
      put: vi.fn(async (_path, body) => body),
    };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByLabelText("الإنهاء قبل نهاية الدوام بيحتاج موافقة المدير"));
    expect(screen.getByText("لازم يكون وقت نهاية الدوام محدد")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toEqual(expect.objectContaining({ early_leave_approval: true }));
  });
```
(`WH` is the working-hours settings fixture already defined in this test file.) Run it → FAIL (label not found).

Implement in `SettingsPanel.jsx`:
- In the save payload add `early_leave_approval: Boolean(s.early_leave_approval),` next to `activity_monitoring`.
- After the note-policy `<div className="field">…</div>` add:
```jsx
      <div className="field check">
        <label><input id="early-leave" type="checkbox" checked={Boolean(s.early_leave_approval)}
          onChange={(e) => setS({ ...s, early_leave_approval: e.target.checked })} />{t("settings.earlyLeave")}</label>
        {s.early_leave_approval && !s.work_end && <p className="hint">{t("settings.earlyLeaveHint")}</p>}
      </div>
```
Run the settings tests → PASS.

- [ ] **Step 6: Report label (failing test first)** — add to `ReportPanel.test.jsx`:
```jsx
  it("labels a session that ended with the manager's approval", async () => {
    const sessions = [{ id: "s1", started_at: 1000, ended_at: 4600, break_sec: 0, note: "موعد", late_by_sec: null, closed_by: "approved" }];
    wrap(<ReportPanel api={makeApi({ sessions })} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("بموافقة المدير")).toBeInTheDocument();
  });
```
Run → FAIL (shows the raw code "approved"). Then in `ReportPanel.jsx` change `const CLOSED_BY = new Set(["user", "auto", "admin"]);` to `const CLOSED_BY = new Set(["user", "auto", "admin", "approved"]);`. Run → PASS.

- [ ] **Step 7: Run every frontend test and the build**

Run: `cd web && npx vitest run` then `cd .. && npm run build`
Expected: all tests PASS; build prints `✓ built`.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(early-leave): manager panel, settings checkbox and report label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end check, docs, and hand-off for the migration

**Files:**
- Modify: `docs/PROGRESS.md`, `docs/DECISIONS.md`, `CLAUDE.md` (folder list), `docs/superpowers/specs/2026-10-07-early-leave-approval-design.md` (status line)

- [ ] **Step 1: Full test run** — with the API restarted on the new code:
`npm run test:unit` · `BASE_URL=http://localhost:3000 node --env-file=.env scripts/smoke-test.mjs` · `cd web && npx vitest run`
Expected: `0 failed` everywhere.

- [ ] **Step 2: Browser check (local)** — run `cd web && npx vite --port 5173` with the API on :3000, set the `dev-local` settings to `timezone: UTC, work_start: 00:00, work_end: 23:59, early_leave_approval: 1` (via the manager settings screen in the dev-login), then: employee clocks in → presses end → dialog → sends → manager (second tab, dev-login manager) sees it, declines with a note → employee sees the decline after ≤ 30 s or on tab return → sends again → manager approves → employee screen shows the approval banner and "طلباتي" lists all three. Report what was seen.

- [ ] **Step 3: Docs**
  - `CLAUDE.md` folder list: add `EarlyLeaveDialog, MyEarlyLeave, EarlyLeavePanel` to the components line.
  - `docs/DECISIONS.md`: append "2026-10-07 — Early-leave approval" with the decisions table from the spec §1 and the rejected alternatives (alerts table reuse; end at request time).
  - `docs/PROGRESS.md`: new session-log entry (newest on top) — feature, migration 007 **pending in production**, test counts.
  - Spec status line → `implemented on <branch>, migration 007 pending in production`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "docs: early-leave approval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Stop before deploying.** Do **not** merge or push to `main` until the owner confirms migration 007 is applied in phpMyAdmin (it adds the column `/session/stop` reads). Hand the owner the SQL file path and the check:
`SHOW COLUMNS FROM settings LIKE 'early_leave_approval'; SHOW TABLES LIKE 'early_leave_requests'; SHOW COLUMNS FROM sessions LIKE 'closed_by';`
