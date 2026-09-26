/**
 * End-to-end smoke test for the TimeClock API.
 * Simulates GHL SSO by encrypting a fake user payload with the same
 * CryptoJS AES passphrase format that GHL uses.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=... npm run test:smoke
 *
 * Uses a random location id per run, so it never touches real client data.
 */
import CryptoJS from "crypto-js";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SECRET = process.env.GHL_SHARED_SECRET;
if (!SECRET) { console.error("Set GHL_SHARED_SECRET"); process.exit(1); }

const LOC = `smoke-${Date.now()}`;
let passed = 0, failed = 0;

function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function sso(payload, secret = SECRET) {
  const encryptedData = CryptoJS.AES.encrypt(JSON.stringify(payload), secret).toString();
  const r = await fetch(`${BASE}/auth/sso`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ encryptedData }),
  });
  return { status: r.status, body: await r.json() };
}

async function call(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Local-dev fallback for DB_* when the smoke test is launched without --env-file. */
function readDotEnv() {
  try {
    const path = new URL("../.env", import.meta.url);
    const out = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*(DB_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch { return {}; }
}

/**
 * Best-effort removal of one fixture location's rows, so test data does not accumulate.
 * Only attempted against a LOCAL dev database and only when DB credentials are present
 * in the environment (e.g. `node --env-file=.env scripts/smoke-test.mjs`); a run against
 * a remote host skips it and never issues a DELETE there.
 */
async function cleanupLocation(loc) {
  const cfg = { ...readDotEnv(), ...process.env };
  const host = cfg.DB_HOST || "localhost";
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocal || !cfg.DB_NAME || !cfg.DB_USER) {
    console.log(`  (cleanup of ${loc} skipped: no local DB credentials)`);
    return;
  }
  let conn;
  try {
    const mysql = (await import("mysql2/promise")).default;
    conn = await mysql.createConnection({
      host,
      port: Number(cfg.DB_PORT || 3306),
      user: cfg.DB_USER,
      password: cfg.DB_PASSWORD,
      database: cfg.DB_NAME,
      namedPlaceholders: true,
    });
    for (const table of ["edits_log", "sessions", "employees", "settings"]) {
      await conn.execute(`DELETE FROM ${table} WHERE location_id = :loc`, { loc });
    }
    console.log(`  (cleaned up fixture location ${loc})`);
  } catch (e) {
    console.log(`  (cleanup of ${loc} skipped: ${e.code || e.message})`);
  } finally {
    await conn?.end().catch(() => {});
  }
}

console.log(`Smoke test → ${BASE} (location ${LOC})`);

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
check("health ok", health?.ok === true);

const emp = await sso({ userId: `${LOC}-u1`, role: "user", type: "account", activeLocation: LOC, userName: "أحمد", email: "a@x.com" });
const mgr = await sso({ userId: `${LOC}-m1`, role: "admin", type: "account", activeLocation: LOC, userName: "Manager", email: "m@x.com" });
check("employee SSO → role employee", emp.body?.user?.role === "employee");
check("admin SSO → role manager", mgr.body?.user?.role === "manager");

const bad = await sso({ userId: "x", activeLocation: LOC }, "wrong-secret");
check("wrong secret rejected", bad.status === 401 || bad.status === 400, `(got ${bad.status})`);

const noLoc = await sso({ userId: "x", role: "admin", type: "agency" });
check("agency view without sub-account rejected", noLoc.status === 403);

const E = emp.body.token, M = mgr.body.token;

check("start → 201", (await call(E, "POST", "/session/start")).status === 201);
check("second start → 409", (await call(E, "POST", "/session/start")).status === 409);

const st = await call(E, "GET", "/me/status");
check("status shows open session", !!st.body?.open_session);

check("employee blocked from admin", (await call(E, "GET", "/admin/live")).status === 403);

const live = await call(M, "GET", "/admin/live");
check("manager sees live list", Array.isArray(live.body?.employees) && live.body.employees.length === 2);

await sleep(1100);
const stop = await call(E, "POST", "/session/stop");
check("stop → 200 with duration", stop.status === 200 && stop.body.duration_sec >= 1);
check("second stop → 409", (await call(E, "POST", "/session/stop")).status === 409);

const t = Math.floor(Date.now() / 1000);
const rep = await call(M, "GET", `/admin/report?from=${t - 86400}&to=${t + 10}`);
const row = rep.body?.employees?.find((e) => e.name === "أحمد");
check("report returns worked_sec", row && row.worked_sec >= 1);
check("report returns late_days", row && typeof row.late_days === "number");

const list = await call(M, "GET", `/admin/sessions?from=${t - 86400}&to=${t + 10}`);
const sid = list.body?.sessions?.[0]?.id;
check("sessions list", !!sid);

const mySessions = await call(E, "GET", "/me/sessions?days=7");
check("employee sees own sessions", mySessions.status === 200 && Array.isArray(mySessions.body?.sessions) && mySessions.body.sessions.length >= 1);
const mgrMine = await call(M, "GET", "/me/sessions?days=7");
check("manager's own history excludes the employee's rows",
  mgrMine.status === 200 && (mgrMine.body?.sessions ?? []).length === 0, `(status ${mgrMine.status})`);

check("edit without reason → 400",
  (await call(M, "PATCH", `/admin/sessions/${sid}`, { started_at: t - 7200, ended_at: t - 3600 })).status === 400);
const edit = await call(M, "PATCH", `/admin/sessions/${sid}`, { started_at: t - 7200, ended_at: t - 3600, reason: "نسي يسجل" });
check("edit with reason → 200", edit.status === 200 && edit.body.duration_sec === 3600);

const set = await call(M, "PUT", "/admin/settings", { timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 20 });
check("late_grace_minutes saved", set.body?.late_grace_minutes === 20);
const badGrace = await call(M, "PUT", "/admin/settings", { timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, late_grace_minutes: 500 });
check("late_grace_minutes out of range → 400", badGrace.status === 400);
check("settings update", set.status === 200 && set.body.timezone === "Asia/Dubai");
const meSet = await call(E, "GET", "/me/settings");
check("employee can read location settings", meSet.status === 200 && meSet.body?.daily_target_hours === 8);
check("invalid timezone → 400",
  (await call(M, "PUT", "/admin/settings", { timezone: "Mars/Base", daily_target_hours: 8, max_session_hours: 10 })).status === 400);

const csv = await call(M, "GET", `/admin/export.csv?from=${t - 86400}&to=${t + 10}`);
check("CSV contains Arabic name", csv.status === 200 && String(csv.body).includes("أحمد"));

// --- late_days must count a day whose FIRST session is after work_start + grace,
// --- even when a rolling window starts after that first session (Finding 2 regression).
const lateEmp = await sso({ userId: `${LOC}-u2`, role: "user", type: "account", activeLocation: LOC, userName: "متأخر", email: "l@x.com" });
const L = lateEmp.body.token;
await call(L, "POST", "/session/start"); await call(L, "POST", "/session/stop");
await call(L, "POST", "/session/start"); await call(L, "POST", "/session/stop");
const mine = await call(M, "GET", `/admin/sessions?from=${t - 86400}&to=${t + 10}&user_id=${LOC}-u2`);
const ids = (mine.body?.sessions ?? []).map((x) => x.id);
// Pin both to yesterday (UTC day, so local day == UTC day): 10:00-11:00 then 14:00-15:00.
const dayStart = Math.floor(t / 86400) * 86400 - 86400;
const firstStart = dayStart + 10 * 3600, secondStart = dayStart + 14 * 3600;
const pinned = ids.length === 2
  && (await call(M, "PATCH", `/admin/sessions/${ids[0]}`, { started_at: firstStart, ended_at: firstStart + 3600, reason: "تثبيت وقت للاختبار" })).status === 200
  && (await call(M, "PATCH", `/admin/sessions/${ids[1]}`, { started_at: secondStart, ended_at: secondStart + 3600, reason: "تثبيت وقت للاختبار" })).status === 200;
check("late-days fixture pinned to known times", pinned, `(ids ${ids.length})`);
// work_start 00:00 + 0 grace ⇒ the 10:00 first session is unambiguously late.
await call(M, "PUT", "/admin/settings", { timezone: "UTC", daily_target_hours: 8, max_session_hours: 12, work_start: "00:00", late_grace_minutes: 0 });
// Rolling window starting at 12:00 — after the first session, before the second.
const lateRep = await call(M, "GET", `/admin/report?from=${dayStart + 12 * 3600}&to=${t + 10}`);
const lateRow = lateRep.body?.employees?.find((e) => e.user_id === `${LOC}-u2`);
check("report counts a late first session outside the window", lateRow && lateRow.late_days >= 1,
  `(got ${JSON.stringify(lateRow?.late_days)})`);

// --- grace boundary on a NON-UTC location (spec §8). Asia/Dubai (UTC+4 year-round,
// --- no DST), work_start 09:00, late_grace_minutes 15 ⇒ lateAfterSec = 33300, so a
// --- first session starting at exactly local 09:15:00 is on time and 09:15:01 is late.
// --- Runs on its own location id so it cannot disturb the checks above; its rows are
// --- removed at the end of the block.
const TZLOC = `${LOC}-tz`;
const tzMgr = await sso({ userId: `${TZLOC}-m1`, role: "admin", type: "account", activeLocation: TZLOC, userName: "مدير دبي", email: "tm@x.com" });
const tzEmp = await sso({ userId: `${TZLOC}-u1`, role: "user", type: "account", activeLocation: TZLOC, userName: "موظف دبي", email: "te@x.com" });
const TM = tzMgr.body?.token, TE = tzEmp.body?.token;
const tzSet = await call(TM, "PUT", "/admin/settings",
  { timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 24, work_start: "09:00", late_grace_minutes: 15 });
check("grace fixture: Asia/Dubai 09:00 + 15min saved",
  tzSet.status === 200 && tzSet.body?.timezone === "Asia/Dubai" && tzSet.body?.late_grace_minutes === 15,
  `(status ${tzSet.status}, grace ${JSON.stringify(tzSet.body?.late_grace_minutes)})`);

await call(TE, "POST", "/session/start"); await call(TE, "POST", "/session/stop");
const tzList = await call(TM, "GET", `/admin/sessions?from=${t - 86400}&to=${t + 10}&user_id=${TZLOC}-u1`);
const tzSid = tzList.body?.sessions?.[0]?.id;
check("grace fixture: session created", !!tzSid);

const DUBAI_OFF = 4 * 3600;                            // Asia/Dubai has no DST
const tzDay = Math.floor(t / 86400) * 86400 - 86400;   // yesterday 00:00 UTC
// Instants whose Asia/Dubai wall clock is exactly 09:15:00 and 09:15:01 on that local day.
const onTimeAt = tzDay - DUBAI_OFF + 9 * 3600 + 15 * 60;
const tzFrom = tzDay - 86400, tzTo = t + 10;

async function tzLateDays(startedAt) {
  const pin = await call(TM, "PATCH", `/admin/sessions/${tzSid}`,
    { started_at: startedAt, ended_at: startedAt + 3600, reason: "تثبيت حد السماح للاختبار" });
  if (pin.status !== 200) return { pin: pin.status, late_days: null };
  const r = await call(TM, "GET", `/admin/report?from=${tzFrom}&to=${tzTo}`);
  const row = r.body?.employees?.find((e) => e.user_id === `${TZLOC}-u1`);
  return { pin: 200, late_days: row?.late_days, days_present: Number(row?.days_present) };
}

const onTime = await tzLateDays(onTimeAt);
check("grace boundary: local 09:15:00 is NOT late",
  onTime.pin === 200 && onTime.late_days === 0 && onTime.days_present === 1,
  `(late_days ${JSON.stringify(onTime.late_days)}, days_present ${JSON.stringify(onTime.days_present)})`);
const oneLate = await tzLateDays(onTimeAt + 1);
check("grace boundary: local 09:15:01 IS late",
  oneLate.pin === 200 && oneLate.late_days === 1 && oneLate.days_present === 1,
  `(late_days ${JSON.stringify(oneLate.late_days)}, days_present ${JSON.stringify(oneLate.days_present)})`);

// Remove the grace fixture's rows. Only attempted against a local dev database, so a
// run pointed at a remote/production host simply skips it and leaves that DB untouched.
await cleanupLocation(TZLOC);

check("tampered token → 401", (await call(E.slice(0, -2) + "xx", "GET", "/me/status")).status === 401);

// --- dev-login (only meaningful when the target server runs with NODE_ENV != production) ---
const dev = await fetch(`${BASE}/auth/dev-login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ role: "manager" }),
});
if (dev.status === 404) {
  check("dev-login disabled (server in production mode)", true);
} else {
  const devBody = await dev.json();
  check("dev-login returns a manager token", dev.status === 200 && devBody?.user?.role === "manager");
  const devEmp = await fetch(`${BASE}/auth/dev-login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "employee" }),
  }).then((r) => r.json());
  check("dev-login employee role", devEmp?.user?.role === "employee");
  const meDev = await call(devBody.token, "GET", "/me/status");
  check("dev-login token works on protected route", meDev.status === 200);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
