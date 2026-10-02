# Activity Monitoring — Phase C (Idle Alert) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a clocked-in employee has had no activity for longer than the manager's threshold (1–240 minutes), raise an alert to the manager and the employee inside the app; the alert stays with the manager until dismissed, the employee can answer it, and both screens refresh every minute with a ⚠️ tab title.

**Architecture:** Two more pure rules in `src/activity.js` (`idleAlertAt`, `isLateActivity`, plus `onBreakAt`). In `src/server.js` a detector `detectIdle(loc)` runs on a 60-second timer and lazily before the alert and live reads; a stored counted event ends the ongoing stretch (`endIdleStretch`), and every session end closes it (`closeIdleOnEndedSessions`). No migration — `activity_alerts` already has `session_id`, `to_at`, `idle_open_flag` and the `late_activity` resolution. The React app shows idle rows to the manager, an idle banner to the employee, polls every minute and marks the tab title.

**Tech Stack:** Node 20 ESM · Hono 4 · mysql2 · `node:test` · React 18 · Vitest 2 · MariaDB locally (Docker `timeclock-db`)

**Spec:** `docs/superpowers/specs/2026-09-29-activity-monitoring-design.md` §12 (phase C), with §5.3–§5.6 as the phase-B context it builds on.

## Global Constraints

- Plain ESM JavaScript, 2-space indent, semicolons. No new dependencies. No migration.
- SQL runs on MySQL 8 and MariaDB 10.2+ (no `IF NOT EXISTS` on columns, no `RETURNING`, no `INSERT … AS alias`, no partial indexes).
- `location_id` / `user_id` on authenticated routes come only from `c.get("claims")`; `/admin/*` routes use `authed, managerOnly`.
- **Activity never changes hours**: nothing starts, stops or shortens a session.
- Only events **with** a `user_id` are activity.
- Idle = time from last activity (latest of session start, `activity_monitoring_since`, the employee's last counted event since the session started) to now, **minus breaks** (employee breaks and the fixed window, paid or not).
- An idle alert opens when idle ≥ `idle_minutes × 60`, the employee is not on a break and not inside the fixed window right now, monitoring is on, and the location has an `activity_events` row from the last 24 h. Working hours do not apply.
- At most one **ongoing** idle alert per session (`ux_alert_idle_open`); a stretch already alerted (same `session_id` + `from_at`) is never alerted twice, even after a dismiss.
- A counted event with `occurred_at ≥ from_at` sets the ongoing alert's `to_at` = `occurred_at` and keeps it `open`; if `activeSeconds(from_at, occurred_at, breaks) < idle_minutes × 60` it is instead resolved `late_activity` by `system`.
- A session end (stop, auto-close, manager edit) sets an ongoing alert's `to_at` = `GREATEST(from_at, ended_at)`; it stays open.
- `GET /me/alerts` returns open not-clocked-in alerts and **ongoing** idle alerts only. `idle_minutes` allowed 1–240 (`400 INVALID_IDLE_MINUTES`).
- UI: Arabic, RTL, Western digits, times in the location's timezone. Employee screen and manager panel refresh every 60 s; tab title starts with `⚠️ ` while an alert is shown.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push from a task.

## Shared commands

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
open -a Docker; docker start timeclock-db       # local DB (Docker Desktop must be running)
pkill -f "node --env-file=.env src/server.js"; nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health | grep -q '"ok":true'; do sleep 1; done; echo up
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "FAIL|SKIP|passed"
npm run test:unit
cd web && npx vitest run
```

**Baseline:** smoke **175 passed, 0 failed** (foreign-appId SKIP); unit **49**; frontend **126**.

## File map

| File | Change |
|---|---|
| `src/activity.js`, `src/activity.test.mjs` | `onBreakAt`, `idleAlertAt`, `isLateActivity` (T1) |
| `src/server.js` | detector, resume/late, session-end close, `/me/alerts` filter, `session_id` in alert rows, `idle_minutes` 1–240, timer (T2) |
| `scripts/smoke-test.mjs`, `PROJECT.md` | T2 |
| `web/src/alertTitle.js` (+ test), `web/src/components/AlertsPanel.jsx` (+ test), `web/src/components/SettingsPanel.jsx` (+ test) | T3 |
| `web/src/components/EmployeeScreen.jsx` (+ test) | T4 |
| `CLAUDE.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md` | T5 |

---

### Task 1: Pure rules for the idle alert

**Files:**
- Modify: `src/activity.js` (append), `src/activity.test.mjs` (append)

**Interfaces:**
- Consumes: `lastActivityAt`, `activeSeconds` (same file).
- Produces:
  - `onBreakAt(breaks: Array<[number, number|null]>, now: number): boolean`
  - `idleAlertAt({ startedAt, monitoringSince?, lastEventAt?, now, breaks?, idleMinutes }): number | null` — the `from_at` to open with, or null
  - `isLateActivity({ fromAt, occurredAt, breaks?, idleMinutes }): boolean`

- [ ] **Step 1: Write the failing tests** — append to `src/activity.test.mjs` (and add `onBreakAt, idleAlertAt, isLateActivity` to its import list from `./activity.js`):

```js
test("onBreakAt: inside a closed or running break, not at its end", () => {
  assert.equal(onBreakAt([[100, 200]], 150), true);
  assert.equal(onBreakAt([[100, 200]], 200), false);
  assert.equal(onBreakAt([[100, null]], 5000), true);
  assert.equal(onBreakAt([], 150), false);
});

test("idleAlertAt opens at the threshold, from the last activity", () => {
  // started 0, last event 1000, threshold 10 min → opens at 1600, from 1000
  assert.equal(idleAlertAt({ startedAt: 0, lastEventAt: 1000, now: 1599, idleMinutes: 10 }), null);
  assert.equal(idleAlertAt({ startedAt: 0, lastEventAt: 1000, now: 1600, idleMinutes: 10 }), 1000);
  // monitoring started later than the event: idle counts from the monitoring start
  assert.equal(idleAlertAt({ startedAt: 0, monitoringSince: 2000, lastEventAt: 1000, now: 2600, idleMinutes: 10 }), 2000);
  // a one-minute threshold
  assert.equal(idleAlertAt({ startedAt: 0, now: 60, idleMinutes: 1 }), 0);
});

test("idleAlertAt: break time does not count, and nothing opens during a break", () => {
  // 0..1200 with a 300 s break → 900 s idle < 1200 (20 min)
  assert.equal(idleAlertAt({ startedAt: 0, now: 1200, breaks: [[100, 400]], idleMinutes: 20 }), null);
  assert.equal(idleAlertAt({ startedAt: 0, now: 1500, breaks: [[100, 400]], idleMinutes: 20 }), 0);
  // on a running break, or inside a fixed window right now
  assert.equal(idleAlertAt({ startedAt: 0, now: 5000, breaks: [[4000, null]], idleMinutes: 1 }), null);
  assert.equal(idleAlertAt({ startedAt: 0, now: 5000, breaks: [[4800, 5400]], idleMinutes: 1 }), null);
});

test("isLateActivity: an event before the stretch reached the threshold", () => {
  assert.equal(isLateActivity({ fromAt: 1000, occurredAt: 1030, idleMinutes: 1 }), true);
  assert.equal(isLateActivity({ fromAt: 1000, occurredAt: 1060, idleMinutes: 1 }), false);
  // break time inside the gap does not count towards the threshold
  assert.equal(isLateActivity({ fromAt: 0, occurredAt: 700, breaks: [[100, 400]], idleMinutes: 10 }), true);
});
```

- [ ] **Step 2: Run** `npm run test:unit` — expected FAIL (`onBreakAt` is not exported).

- [ ] **Step 3: Implement** — append to `src/activity.js`:

```js
/** True while `now` falls inside any break interval (end null = still running). */
export function onBreakAt(breaks, now) {
  return breaks.some(([s, e]) => Number(s) <= now && (e == null || now < Number(e)));
}

/**
 * Phase C (spec §12.1): the `from_at` of an idle alert to open for an open session at `now`,
 * or null. Opens once the idle time (breaks removed) reaches idle_minutes, never while the
 * employee is on a break or inside the fixed window (both are in `breaks`).
 */
export function idleAlertAt({ startedAt, monitoringSince = null, lastEventAt = null, now, breaks = [], idleMinutes }) {
  if (onBreakAt(breaks, now)) return null;
  const from = lastActivityAt({ startedAt, monitoringSince, lastEventAt });
  return activeSeconds(from, now, breaks) >= idleMinutes * 60 ? from : null;
}

/**
 * Spec §12.2: an event at `occurredAt` that ends an idle stretch begun at `fromAt` too early
 * for the stretch to have reached the threshold — a delayed GHL delivery — so the alert is
 * resolved as late activity instead of being kept.
 */
export function isLateActivity({ fromAt, occurredAt, breaks = [], idleMinutes }) {
  return activeSeconds(Number(fromAt), Number(occurredAt), breaks) < idleMinutes * 60;
}
```

- [ ] **Step 4: Run** `npm run test:unit` — expected **53 pass, 0 fail**.

- [ ] **Step 5: Commit**

```bash
git add src/activity.js src/activity.test.mjs
git commit -m "feat(activity): pure rules for opening and late-resolving an idle alert

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server — detect, resume, late, session end

**Files:**
- Modify: `src/server.js`, `scripts/smoke-test.mjs`, `PROJECT.md` (§8)

**Interfaces:**
- Consumes: `idleAlertAt`, `isLateActivity` (Task 1); existing `sessionBreaks(session, st, until)`, `getSettings`, `q`, `now`, `randomUUID`, `ALERT_COLUMNS`, `alertRow`.
- Produces: `GET /admin/alerts` and `GET /me/alerts` rows include `session_id` and `idle` alerts; `GET /me/alerts` only returns ongoing idle alerts (`to_at` null); `PUT /admin/settings` accepts `idle_minutes` 1–240.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, change the existing check

```js
check("idle threshold outside 10–240 → 400",
  (await awPolicy({ activity_monitoring: true, idle_minutes: 5 })).body?.error === "INVALID_IDLE_MINUTES");
```

to

```js
check("idle threshold outside 1–240 → 400",
  (await awPolicy({ activity_monitoring: true, idle_minutes: 0 })).body?.error === "INVALID_IDLE_MINUTES");
```

Then, directly **after** the line `await cleanupLocation(IDLOC);` (and before `const awBig = …`), add:

```js
// --- Idle alert (activity phase C, spec §12). Own location; needs the test key and a local DB.
const ICLOC = `${LOC}-ic`;
const icMgr = await sso({ userId: `${ICLOC}-m1`, role: "admin", type: "account", activeLocation: ICLOC, userName: "مدير الخمول ج", email: "icm@x.com" });
const icEmp = await sso({ userId: `${ICLOC}-u1`, role: "user", type: "account", activeLocation: ICLOC, userName: "موظف الخمول ج", email: "ice@x.com" });
const ICM = icMgr.body?.token, ICE = icEmp.body?.token;
let icSeq = 0;
const icEvent = (userId, at = Math.floor(Date.now() / 1000)) => {
  icSeq++;
  return ghlWebhook({ type: "OutboundMessage", locationId: ICLOC, userId, messageType: "SMS", source: "app",
    dateAdded: new Date(at * 1000).toISOString(), webhookId: `${ICLOC}-w${icSeq}`, messageId: `${ICLOC}-m${icSeq}` });
};
const icIdle = async (status = "open") =>
  ((await call(ICM, "GET", `/admin/alerts?status=${status}`)).body?.alerts ?? []).filter((a) => a.kind === "idle");
const icMine = async () => ((await call(ICE, "GET", "/me/alerts")).body?.alerts ?? []).filter((a) => a.kind === "idle");
const icBackdate = (sec) => localRows("UPDATE sessions SET started_at = :s WHERE location_id = :loc AND ended_at IS NULL",
  { s: Math.floor(Date.now() / 1000) - sec, loc: ICLOC });

const icSet = await call(ICM, "PUT", "/admin/settings",
  { timezone: "UTC", activity_monitoring: true, idle_minutes: 1, break_mode: "flexible" });
check("a one-minute idle threshold is accepted", icSet.body?.idle_minutes === 1, `(${icSet.status} ${JSON.stringify(icSet.body?.error)})`);
const icT = Math.floor(Date.now() / 1000);
const icBack = await withLocalDb((conn) =>
  conn.execute("UPDATE settings SET activity_monitoring_since = ? WHERE location_id = ?", [icT - 7200, ICLOC]));
if (!awAcceptsTestKey || icBack.skipped) {
  console.log(`  SKIP  idle alert checks (${icBack.skipped ?? "target refuses the test signing key"})`);
} else {
  await call(ICE, "POST", "/session/start");
  await icBackdate(600);
  check("no idle alert while no event reached the location in 24 hours", (await icIdle()).length === 0);

  await icEvent(`${ICLOC}-stranger`); // someone who never opened TimeClock: proves events arrive
  const icA = (await icIdle())[0];
  check("an idle alert opens once the threshold is passed",
    icA?.session_id && icA.to_at === null && Math.abs(Number(icA.from_at) - (icT - 600)) <= 10 && icA.name === "موظف الخمول ج",
    `(${JSON.stringify(icA)})`);
  check("one ongoing idle alert per session", (await icIdle()).length === 1);
  const icMine1 = await icMine();
  check("the employee sees the ongoing idle alert", icMine1.length === 1 && icMine1[0].id === icA?.id);
  check("the employee can note the idle alert",
    (await call(ICE, "POST", `/me/alerts/${icA?.id}/note`, { note: "كنت بمكالمة" })).status === 200);

  await icEvent(`${ICLOC}-u1`);
  const icB = (await icIdle()).find((a) => a.id === icA?.id);
  check("activity ends the stretch but the alert stays open for the manager",
    icB?.status === "open" && Math.abs(Number(icB?.to_at) - icT) <= 15 && icB?.employee_note === "كنت بمكالمة",
    `(${JSON.stringify(icB)})`);
  check("an ended stretch leaves the employee's list", (await icMine()).length === 0);
  check("the manager dismisses the idle alert", (await call(ICM, "POST", `/admin/alerts/${icA?.id}/dismiss`)).status === 200);

  // A late delivery: move the employee's events back so a new stretch is open from icT − 300
  // (after the session start, so it is a different stretch from the dismissed one), then
  // deliver an event only 30 s into that stretch.
  await localRows("UPDATE activity_events SET occurred_at = :at WHERE location_id = :loc AND user_id = :uid",
    { at: icT - 300, loc: ICLOC, uid: `${ICLOC}-u1` });
  const icC = (await icIdle()).find((a) => a.id !== icA?.id);
  check("a new quiet stretch opens a new idle alert", icC && Math.abs(Number(icC.from_at) - (icT - 300)) <= 10,
    `(${JSON.stringify(icC)})`);
  await icEvent(`${ICLOC}-u1`, icT - 270);
  const icCr = (await icIdle("resolved")).find((a) => a.id === icC?.id);
  check("a late event inside the gap resolves it as late activity", icCr?.resolution === "late_activity",
    `(${JSON.stringify(icCr)})`);

  const icD = (await icIdle()).find((a) => a.to_at === null);
  await call(ICE, "POST", "/session/stop");
  const icDe = (await icIdle()).find((a) => a.id === icD?.id);
  check("stopping the session ends the ongoing idle alert, which stays open",
    icD && icDe?.status === "open" && Number(icDe?.to_at) >= Number(icD.from_at), `(${JSON.stringify(icDe)})`);

  await call(ICE, "POST", "/session/start");
  await icBackdate(600);
  await call(ICE, "POST", "/session/break/start");
  check("no idle alert opens while the employee is on a break", !(await icIdle()).some((a) => a.to_at === null));
  await call(ICE, "POST", "/session/break/stop");
  check("after the break the idle alert opens", (await icIdle()).some((a) => a.to_at === null));
  await call(ICE, "POST", "/session/stop");
}
await cleanupLocation(ICLOC);
```

- [ ] **Step 2: Run** (restart the API, then the smoke test). Expected: the 0-threshold check and the new idle checks FAIL (1 is still rejected; no idle alerts exist).

- [ ] **Step 3: Implement in `src/server.js`**

1. Import the new rules:

```js
import { isWithinWorkHours, isFreshEvent, idleSeconds, sessionSummary, idleAlertAt, isLateActivity } from "./activity.js";
```

(keep whatever the current import line already lists; add `idleAlertAt, isLateActivity`).

2. Below `eventTimes(...)`, add one helper used by both the live floor and the detector:

```js
/** This employee's latest counted event inside [from, to], or null. */
async function lastEventAt(loc, uid, from, to) {
  const [row] = await q(
    `SELECT MAX(occurred_at) AS at FROM activity_events
      WHERE location_id = :loc AND user_id = :uid AND occurred_at >= :from AND occurred_at <= :to`,
    { loc, uid, from, to }
  );
  return row?.at == null ? null : Number(row.at);
}
```

and in `liveActivity` replace its inline `SELECT MAX(occurred_at) …` query and `const lastEventAt = …` with `const lastAt = await lastEventAt(loc, e.user_id, start, t);`, then use `lastAt` in place of `lastEventAt` in the two lines below it (`row.last_activity_at = lastAt;` and `idleSeconds({ …, lastEventAt: lastAt, … })`).

3. After `liveActivity`, add the phase-C functions:

```js
/**
 * Phase C (spec §12.1): opens an idle alert for every open session at a monitored location
 * whose quiet stretch (breaks removed) reached idle_minutes. Runs on a 60 s timer and lazily
 * before the alert and live reads. ux_alert_idle_open keeps one ongoing alert per session; a
 * stretch already alerted (same session and from_at) is never alerted again, even after a
 * dismiss. Outage guard: no alert unless the location received an event in the last 24 h.
 */
async function detectIdle(loc = null) {
  const locs = loc
    ? [loc]
    : (await q("SELECT location_id FROM settings WHERE activity_monitoring = 1")).map((r) => r.location_id);
  const t = now();
  for (const l of locs) {
    try {
      const st = await getSettings(l);
      if (!st?.activity_monitoring) continue;
      const [fresh] = await q(
        "SELECT 1 AS ok FROM activity_events WHERE location_id = :loc AND occurred_at > :cutoff LIMIT 1",
        { loc: l, cutoff: t - 86400 }
      );
      if (!fresh) continue;
      const open = await q(
        "SELECT id, user_id, started_at FROM sessions WHERE location_id = :loc AND ended_at IS NULL",
        { loc: l }
      );
      for (const s of open) {
        const start = Number(s.started_at);
        const fromAt = idleAlertAt({
          startedAt: start, monitoringSince: st.activity_monitoring_since,
          lastEventAt: await lastEventAt(l, s.user_id, start, t), now: t,
          breaks: await sessionBreaks(s, st, t), idleMinutes: Number(st.idle_minutes),
        });
        if (fromAt == null) continue;
        const [seen] = await q(
          "SELECT 1 AS ok FROM activity_alerts WHERE session_id = :sid AND kind = 'idle' AND from_at = :fromAt LIMIT 1",
          { sid: s.id, fromAt }
        );
        if (seen) continue;
        await q(
          `INSERT IGNORE INTO activity_alerts (id, location_id, user_id, session_id, kind, from_at, detected_at, status)
           VALUES (:id, :loc, :uid, :sid, 'idle', :fromAt, :t, 'open')`,
          { id: randomUUID(), loc: l, uid: s.user_id, sid: s.id, fromAt, t }
        );
      }
    } catch (e) {
      console.error("[idle-detect]", l, e);
    }
  }
}

/**
 * Spec §12.2: a counted event ends this employee's ongoing idle stretch. The alert keeps
 * status open for the manager with to_at = the event time — or, when the stretch never
 * really reached the threshold (a delayed delivery), it is resolved as late activity.
 */
async function endIdleStretch(st, loc, uid, at, t) {
  const rows = await q(
    `SELECT a.id, a.from_at, a.session_id, s.started_at
       FROM activity_alerts a JOIN sessions s ON s.id = a.session_id
      WHERE a.location_id = :loc AND a.user_id = :uid AND a.kind = 'idle'
        AND a.status = 'open' AND a.to_at IS NULL AND a.from_at <= :at`,
    { loc, uid, at }
  );
  for (const a of rows) {
    const breaks = await sessionBreaks({ id: a.session_id, started_at: a.started_at }, st, at);
    if (isLateActivity({ fromAt: a.from_at, occurredAt: at, breaks, idleMinutes: Number(st.idle_minutes) })) {
      await q(
        `UPDATE activity_alerts
            SET to_at = :at, status = 'resolved', resolution = 'late_activity', resolved_by = 'system', resolved_at = :t
          WHERE id = :id AND to_at IS NULL`,
        { at, t, id: a.id }
      );
    } else {
      await q("UPDATE activity_alerts SET to_at = :at WHERE id = :id AND to_at IS NULL", { at, id: a.id });
    }
  }
}

/**
 * Spec §12.2: an ongoing idle alert of a session that has ended (stop, auto-close, manager
 * edit) ends with the session; it stays open for the manager. One rule for every close path.
 */
async function closeIdleOnEndedSessions(loc = null) {
  await q(
    `UPDATE activity_alerts a JOIN sessions s ON s.id = a.session_id
        SET a.to_at = GREATEST(a.from_at, s.ended_at)
      WHERE a.kind = 'idle' AND a.status = 'open' AND a.to_at IS NULL AND s.ended_at IS NOT NULL
        AND (:loc IS NULL OR a.location_id = :loc)`,
    { loc }
  );
}
```

4. Wire the session-end rule:
   - at the end of `autoCloseStale`, **before** the summarizer line: `await closeIdleOnEndedSessions(loc).catch((e) => console.error("[idle-close]", e));`
   - in `/session/stop`, right after `await conn.commit();`: the same line;
   - in `PATCH /admin/sessions/:id`, right after its `await conn.commit();`: the same line.

5. Lazy detection — add as the first statement after reading the claims in `GET /admin/live`, `GET /admin/alerts` and `GET /me/alerts`:

```js
  await detectIdle(loc).catch((e) => console.error("[idle-detect]", e));
```

6. `GET /me/alerts`: only alerts the employee can still act on — change its `WHERE` to

```sql
      WHERE a.location_id = :loc AND a.user_id = :uid AND a.status = 'open'
        AND (a.kind <> 'idle' OR a.to_at IS NULL)
```

7. `ALERT_COLUMNS`: add `a.session_id` (e.g. `a.id, a.user_id, a.session_id, a.kind, …`).

8. Webhook activity block: replace the single line

```js
      if (ev.userId && stored.affectedRows > 0) await openNotClockedInAlert(st, ev.locationId, String(ev.userId), ev.occurredAt, t);
```

with

```js
      if (ev.userId && stored.affectedRows > 0) {
        await endIdleStretch(st, ev.locationId, String(ev.userId), ev.occurredAt, t)
          .catch((e) => console.error("[idle-resume]", e));
        await openNotClockedInAlert(st, ev.locationId, String(ev.userId), ev.occurredAt, t);
      }
```

9. `PUT /admin/settings`: change the idle range check to `idleMinutes < 1 || idleMinutes > 240` (keep everything else).

10. Boot: next to the other timers add

```js
setInterval(() => detectIdle().catch((e) => console.error("[idle-detect]", e)), 60 * 1000);
```

- [ ] **Step 4: Run** — restart the API; smoke expected **0 failed**, 175 + 14 new = **189 passed**; unit 53.

- [ ] **Step 5: Document** — `PROJECT.md` §8:
  - `/admin/alerts` row: rows include `session_id`; `kind` may be `idle` (`from_at` = آخر نشاط، `to_at` = وقت رجوع النشاط أو نهاية الجلسة، `null` إذا لسا جاري).
  - `/me/alerts` row: تنبيهات "بدون دوام" المفتوحة، وتنبيهات الخمول **الجارية** بس (`to_at` = null).
  - `PUT /admin/settings` row and the `INVALID_IDLE_MINUTES` error row: 1–240 بدل 10–240 (message "حد الخمول لازم يكون بين 1 و240 دقيقة").
  - `/webhooks/events` row: add "الحدث المحسوب بيسكّر فترة الخمول الجارية لهالموظف (`to_at`)، وإذا الفترة ما وصلت للحد بتنحل `late_activity`".
  - A line under the manager table: "كل دقيقة (وقبل `/admin/live` و`/admin/alerts` و`/me/alerts`) بيفحص السيرفر الجلسات المفتوحة ويفتح تنبيه `idle` إذا عدّى حد الخمول بلا نشاط (بدون الاستراحات، وبشرط وصل حدث للموقع بآخر 24 ساعة)".

- [ ] **Step 6: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(activity): idle alert — detect every minute, end on activity or session end, late events resolve

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Manager screens — idle rows, ⚠️ title, 1-minute threshold

**Files:**
- Create: `web/src/alertTitle.js`, `web/src/alertTitle.test.jsx`
- Modify: `web/src/components/AlertsPanel.jsx`, `web/src/components/AlertsPanel.test.jsx`, `web/src/components/SettingsPanel.jsx`, `web/src/components/SettingsPanel.test.jsx`

**Interfaces:**
- Consumes: `/admin/alerts` rows with `kind`, `from_at`, `to_at`, `session_id`; `server_time`; `formatTime`, `formatIdle` from `../time.js`.
- Produces: `useAlertTitle(active: boolean)` in `web/src/alertTitle.js` (Task 4 uses it).

- [ ] **Step 1: Write the failing tests**

`web/src/alertTitle.test.jsx`:

```js
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useAlertTitle } from "./alertTitle.js";

function Probe({ active }) { useAlertTitle(active); return null; }

describe("useAlertTitle", () => {
  it("prefixes the title with ⚠️ while active and restores it after", () => {
    document.title = "الدوام";
    const { rerender, unmount } = render(<Probe active />);
    expect(document.title).toBe("⚠️ الدوام");
    rerender(<Probe active={false} />);
    expect(document.title).toBe("الدوام");
    rerender(<Probe active />);
    unmount();
    expect(document.title).toBe("الدوام");
  });
});
```

Append to `web/src/components/AlertsPanel.test.jsx` (inside `describe`):

```js
  it("shows an ongoing idle alert with its minutes, and an ended one with its span", async () => {
    const now = Date.UTC(2026, 9, 5, 8, 0) / 1000;            // 12:00 Dubai
    const from = now - 25 * 60;                                 // 11:35
    const api = {
      get: vi.fn(async (p) => (p.includes("status=open")
        ? { alerts: [
            { id: "i1", user_id: "u1", name: "سارة", kind: "idle", from_at: from, to_at: null },
            { id: "i2", user_id: "u2", name: "أحمد", kind: "idle", from_at: now - 3600, to_at: now - 3600 + 45 * 60 },
          ], timezone: "Asia/Dubai", server_time: now }
        : { alerts: [], server_time: now })),
      post: vi.fn(),
    };
    wrap(<AlertsPanel api={api} />);
    expect(await screen.findByText("بدون نشاط من 11:35 · 25 د")).toBeInTheDocument();
    expect(screen.getByText("بدون نشاط من 11:00 لـ 11:45 (45 د)")).toBeInTheDocument();
  });

  it("lists only not-clocked-in alerts under the employees' notes", async () => {
    const now = Date.UTC(2026, 9, 5, 8, 0) / 1000;
    const api = {
      get: vi.fn(async (p) => (p.includes("status=open")
        ? { alerts: [], timezone: "UTC", server_time: now }
        : { alerts: [
            { id: "r1", user_id: "u1", name: "سارة", kind: "idle", from_at: now - 600, to_at: now - 590, resolved_at: now - 590, employee_note: "ملاحظة خمول" },
          ], server_time: now })),
      post: vi.fn(),
    };
    const { container } = wrap(<AlertsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("ملاحظة خمول")).not.toBeInTheDocument();
    expect(container.querySelector(".alerts")).toBeNull();
  });

  it("marks the tab title while alerts are open", async () => {
    document.title = "الدوام";
    const api = {
      get: vi.fn(async () => ({ alerts: [{ id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: 1 }], timezone: "UTC", server_time: 2 })),
      post: vi.fn(),
    };
    wrap(<AlertsPanel api={api} />);
    await screen.findByText("سارة");
    expect(document.title).toBe("⚠️ الدوام");
  });
```

In `web/src/components/SettingsPanel.test.jsx`, add (inside `describe`, reuse its `wrap`/`BASE` helpers):

```js
  it("accepts a one-minute idle threshold and explains the 1–240 range", async () => {
    const err = Object.assign(new Error("INVALID_IDLE_MINUTES"), { code: "INVALID_IDLE_MINUTES" });
    const api = {
      get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, activity_monitoring: true, idle_minutes: 30 } : { installed: false })),
      put: vi.fn(async () => { throw err; }),
    };
    wrap(<SettingsPanel api={api} />);
    const idle = await screen.findByLabelText("حد الخمول (دقائق)");
    expect(idle).toHaveAttribute("min", "1");
    fireEvent.change(idle, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put.mock.calls[0][1].idle_minutes).toBe(1));
    expect(await screen.findByText("حد الخمول لازم يكون بين 1 و240 دقيقة")).toBeInTheDocument();
  });
```

If an existing SettingsPanel test asserts the old text "حد الخمول لازم يكون بين 10 و240 دقيقة", update that string to the new one.

- [ ] **Step 2: Run** `cd web && npx vitest run src/alertTitle.test.jsx src/components/AlertsPanel.test.jsx src/components/SettingsPanel.test.jsx` — expected FAIL.

- [ ] **Step 3: Implement**

`web/src/alertTitle.js`:

```js
import { useEffect } from "react";

const MARK = "⚠️ ";
const strip = (t) => (t.startsWith(MARK) ? t.slice(MARK.length) : t);

/** Prefixes the tab title with ⚠️ while `active` (spec §12.4) and restores it afterwards. */
export function useAlertTitle(active) {
  useEffect(() => {
    if (!active) return undefined;
    document.title = MARK + strip(document.title);
    return () => { document.title = strip(document.title); };
  }, [active]);
}
```

`web/src/components/AlertsPanel.jsx`:
- import `formatIdle` from `../time.js` and `useAlertTitle` from `../alertTitle.js`;
- keep `serverNow` in state: `setData({ alerts: d.alerts ?? [], notes, timezone: d.timezone ?? null, serverNow: d.server_time ?? null })` (initial state `serverNow: null`);
- the notes filter also requires `a.kind === "working_not_clocked_in"`;
- call `useAlertTitle(data.alerts.length > 0);` before the early `return null`;
- add above the component:

```js
// The line under an alert's name (spec §6, §12.4).
function alertLine(a, tz, serverNow) {
  if (a.kind === "idle") {
    const from = formatTime(a.from_at, tz);
    if (a.to_at == null) return `بدون نشاط من ${from} · ${formatIdle(Math.max(0, (serverNow ?? a.from_at) - a.from_at))}`;
    return `بدون نشاط من ${from} لـ ${formatTime(a.to_at, tz)} (${formatIdle(a.to_at - a.from_at)})`;
  }
  return `عم يشتغل بدون دوام من ${formatTime(a.from_at, tz)}`;
}
```

- in the open rows, replace `<div className="m">عم يشتغل بدون دوام من {formatTime(a.from_at, data.timezone)}</div>` with `<div className="m">{alertLine(a, data.timezone, data.serverNow)}</div>`.

`web/src/components/SettingsPanel.jsx`: the idle input gets `min="1"`, and the `INVALID_IDLE_MINUTES` message becomes `"حد الخمول لازم يكون بين 1 و240 دقيقة"`.

- [ ] **Step 4: Run** `cd web && npx vitest run && cd .. && npm run build` — expected **0 failed**, 126 + 5 = **131 passed**; build OK; no act() warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/alertTitle.js web/src/alertTitle.test.jsx web/src/components/AlertsPanel.jsx web/src/components/AlertsPanel.test.jsx web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx
git commit -m "feat(manager-ui): idle alert rows, warning tab title, one-minute idle threshold

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Employee screen — idle banner, one-minute refresh, ⚠️ title

**Files:**
- Modify: `web/src/components/EmployeeScreen.jsx`, `web/src/components/EmployeeScreen.test.jsx`

**Interfaces:**
- Consumes: `GET /me/alerts` (`alerts` with `kind`, `from_at`, `to_at`; `timezone`; `server_time`); `useAlertTitle` (Task 3); `formatIdle`, `formatTime`.

- [ ] **Step 1: Write the failing tests** — in `EmployeeScreen.test.jsx`, using the file's `makeApi` and `withAlerts` helpers:

```js
  it("tells a clocked-in employee they have been idle", async () => {
    const t = nowSec();
    const from = t - 25 * 60;
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: t - 3600 }, worked_sec: 3600, server_time: t }),
      { alerts: [{ id: "i1", kind: "idle", from_at: from, to_at: null }], timezone: "UTC", server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(from * 1000));
    expect(await screen.findByText(`ما في نشاط من ${hhmm} (25 د)، والمدير رح يشوفها. إذا عم تشتغل اكتبله شو عم تعمل.`)).toBeInTheDocument();
  });

  it("sends a note on the idle alert", async () => {
    const t = nowSec();
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: t - 3600 }, worked_sec: 3600, server_time: t }),
      { alerts: [{ id: "i1", kind: "idle", from_at: t - 600, to_at: null }], timezone: "UTC", server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.change(await screen.findByLabelText("ملاحظة للمدير"), { target: { value: "كنت بمكالمة" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الملاحظة" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/me/alerts/i1/note", { note: "كنت بمكالمة" }));
  });

  it("refreshes status and alerts every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }), { alerts: [], timezone: "UTC" });
      wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/alerts"));
      const before = api.get.mock.calls.filter(([p]) => p === "/me/alerts").length;
      await act(async () => { vi.advanceTimersByTime(60000); });
      await waitFor(() => expect(api.get.mock.calls.filter(([p]) => p === "/me/alerts").length).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the tab title while the employee has an alert", async () => {
    document.title = "الدوام";
    const t = nowSec();
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: t - 3600 }, worked_sec: 3600, server_time: t }),
      { alerts: [{ id: "i1", kind: "idle", from_at: t - 600, to_at: null }], timezone: "UTC", server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByLabelText("ملاحظة للمدير");
    expect(document.title).toBe("⚠️ الدوام");
  });
```

(Add `act` to the `@testing-library/react` import if the file does not already import it.)

- [ ] **Step 2: Run** `cd web && npx vitest run src/components/EmployeeScreen.test.jsx` — expected the 4 new tests FAIL.

- [ ] **Step 3: Implement** in `EmployeeScreen.jsx`:
- import `formatIdle` (with `formatTime`) from `../time.js` and `useAlertTitle` from `../alertTitle.js`;
- store the alerts' server time: `setAlerts({ list: a.alerts ?? [], timezone: a.timezone ?? null, serverTime: a.server_time ?? null })` (and `serverTime: null` in the initial state and in the catch branch);
- refresh every minute (spec §12.4), next to the existing effects:

```js
  // Alerts appear without a reload: the screen re-reads status and alerts every minute.
  useEffect(() => {
    const id = setInterval(() => refresh().catch(() => {}), 60000);
    return () => clearInterval(id);
  }, []);
```

- after `const nci = …`, add `const idle = open ? alerts.list.find((a) => a.kind === "idle" && a.to_at == null) : null;` and `useAlertTitle(Boolean(nci || idle));` — place the hook call **before** the early `if (!status && !error) return …` so the hook order never changes (move the `nci`/`idle` computations up with it, guarding `status` being null: `const open = status?.open_session;` already tolerates null);
- move the note field + send button out of the not-clocked-in banner into a function inside the component, used by both banners:

```jsx
  const noteBox = (id) => (
    <>
      <div className="field">
        <label htmlFor="alert-note">ملاحظة للمدير</label>
        <textarea id="alert-note" maxLength={300} value={alertNote} onChange={(e) => setAlertNote(e.target.value)} />
        {alertNoteError && <span className="err">{alertNoteError}</span>}
      </div>
      <Button variant="ghost" size="sm" disabled={!alertNote.trim() || sendingNote} onClick={() => sendAlertNote(id)}>إرسال الملاحظة</Button>
    </>
  );
```

  (the not-clocked-in banner then renders `{noteBox(nci.id)}` in place of those elements);
- after the not-clocked-in banner add:

```jsx
      {idle && (
        <section className="panel notice" role="status">
          <p>ما في نشاط من {formatTime(idle.from_at, alerts.timezone)} ({formatIdle(Math.max(0, (alerts.serverTime ?? idle.from_at) - idle.from_at))})، والمدير رح يشوفها. إذا عم تشتغل اكتبله شو عم تعمل.</p>
          {noteBox(idle.id)}
        </section>
      )}
```

(The test matches the paragraph's full text; keep it in one `<p>`.)

- [ ] **Step 4: Run** `cd web && npx vitest run && cd .. && npm run build` — expected **0 failed**, 131 + 4 = **135 passed**; build OK; no act() warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx
git commit -m "feat(employee-ui): idle banner with a note, one-minute refresh, warning tab title

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and full verification

**Files:**
- Modify: `CLAUDE.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md`

- [ ] **Step 1: Verify** — unit **53**/0; frontend **135**/0; `npm run build` OK; smoke (development) **189 passed, 0 failed**; then one production-mode smoke run (`NODE_ENV=production node --env-file=.env src/server.js`, expect 0 failed) and restart normally.
- [ ] **Step 2: Docs**
  - `CLAUDE.md` folder list: under `src/time.js` add `  src/alertTitle.js       # ⚠️ tab-title hook while an alert is shown`.
  - `docs/DECISIONS.md` append:

```markdown
## 2026-10-02 — Phase C: the idle alert, after all
- **Decision:** an idle alert to the manager and the employee once a clocked-in employee has no activity
  for longer than `idle_minutes` (now 1–240). It stays open for the manager until dismissed; the
  employee sees it while it is ongoing and can answer with a note. Delivery is in the app: both screens
  refresh every minute and the tab title shows ⚠️. A detector runs every 60 s; activity or a session end
  closes the stretch; a late event inside the gap resolves it `late_activity`.
- **Reason:** the owner wants to be told, not to look for a chip; breaks, the 24 h outage guard and the
  late-event rule keep it fair. "End at last activity" stays deferred (no automatic pay effect).
- **Rejected:** auto-closing the alert on resume (the manager would miss the stretch); browser
  notifications and GHL SMS/WhatsApp (permission prompts inside the iframe; cost).
```

  - `docs/PROGRESS.md`: Current State gains phase C (local, not pushed; no migration needed); a Session Log entry with the commit list and test counts.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/PROGRESS.md docs/DECISIONS.md
git commit -m "docs: record activity monitoring phase C (idle alert)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4:** Do **not** push. The owner deploys: push `main` (no migration), then check `/health`.
