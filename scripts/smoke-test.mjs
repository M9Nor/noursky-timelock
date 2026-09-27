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
 * Runs `fn(conn)` against the LOCAL dev database only, and only when DB credentials are
 * present in the environment or ./.env (e.g. `node --env-file=.env scripts/smoke-test.mjs`).
 * A run against a remote host never touches its database: returns `{ skipped: reason }`.
 */
async function withLocalDb(fn) {
  const cfg = { ...readDotEnv(), ...process.env };
  const host = cfg.DB_HOST || "localhost";
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocal || !cfg.DB_NAME || !cfg.DB_USER) return { skipped: "no local DB credentials" };
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
    await fn(conn);
    return { skipped: null };
  } catch (e) {
    return { skipped: e.code || e.message };
  } finally {
    await conn?.end().catch(() => {});
  }
}

/** Best-effort removal of one fixture location's rows, so test data does not accumulate. */
async function cleanupLocation(loc) {
  const { skipped } = await withLocalDb(async (conn) => {
    for (const table of ["breaks", "edits_log", "sessions", "employees", "settings"]) {
      await conn.execute(`DELETE FROM ${table} WHERE location_id = :loc`, { loc });
    }
  });
  console.log(skipped ? `  (cleanup of ${loc} skipped: ${skipped})` : `  (cleaned up fixture location ${loc})`);
}

/**
 * Backdates a fixture location's break_policy_since, as if its current break policy had
 * been saved at `ts` — the API always stamps "now". Local dev DB only; false elsewhere.
 */
async function setPolicySince(loc, ts) {
  const { skipped } = await withLocalDb((conn) =>
    conn.execute("UPDATE settings SET break_policy_since = :ts WHERE location_id = :loc", { ts, loc }));
  return !skipped;
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
check("employee history carries the location timezone",
  typeof mySessions.body?.timezone === "string" && mySessions.body.timezone.length > 0, `(${mySessions.body?.timezone})`);
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

// /admin/sessions must annotate the day's FIRST session with how late it was, so the
// manager can audit the late_days total. 09:15:01 is 1s past the 09:15:00 threshold.
const lateList = await call(TM, "GET", `/admin/sessions?from=${tzFrom}&to=${tzTo}&user_id=${TZLOC}-u1`);
const lateSession = lateList.body?.sessions?.find((x) => x.id === tzSid);
check("sessions annotate the day's first late session",
  lateList.status === 200 && lateSession?.late_by_sec === 1,
  `(late_by_sec ${JSON.stringify(lateSession?.late_by_sec)})`);
check("sessions response carries the location timezone",
  lateList.body?.timezone === "Asia/Dubai", `(got ${JSON.stringify(lateList.body?.timezone)})`);

// A later session on the same local day is not the day's first, so it is never late.
const tzSecondStart = onTimeAt + 6 * 3600;
const tzSecondOpen = await call(TE, "POST", "/session/start");
const tzSecondId = tzSecondOpen.body?.id;
await call(TM, "PATCH", `/admin/sessions/${tzSecondId}`,
  { started_at: tzSecondStart, ended_at: tzSecondStart + 1800, reason: "جلسة ثانية بنفس اليوم للاختبار" });
const tzBothList = await call(TM, "GET", `/admin/sessions?from=${tzFrom}&to=${tzTo}&user_id=${TZLOC}-u1`);
const tzSecondRow = tzBothList.body?.sessions?.find((x) => x.id === tzSecondId);
const tzFirstRow = tzBothList.body?.sessions?.find((x) => x.id === tzSid);
check("a later session on the same day is not marked late",
  tzSecondRow?.late_by_sec === null && tzFirstRow?.late_by_sec === 1,
  `(second ${JSON.stringify(tzSecondRow?.late_by_sec)}, first ${JSON.stringify(tzFirstRow?.late_by_sec)})`);

// Remove the grace fixture's rows. Only attempted against a local dev database, so a
// run pointed at a remote/production host simply skips it and leaves that DB untouched.
await cleanupLocation(TZLOC);

// --- DST: a report window spanning a daylight-saving change must use the offset in force
// --- on each session's own date, not today's. Europe/Berlin, work_start 09:00, grace 15.
// --- 07:30Z is 08:30 local on 2026-03-20 (CET, on time) but 09:30 local on 2026-04-10
// --- (CEST, 15 min late). A single offset snapshot gets exactly one of them wrong in any
// --- season, so late_days === 1 holds only when each date gets its own offset.
const DSTLOC = `${LOC}-dst`;
const dstMgr = await sso({ userId: `${DSTLOC}-m1`, role: "admin", type: "account", activeLocation: DSTLOC, userName: "مدير برلين", email: "dm@x.com" });
const dstEmp = await sso({ userId: `${DSTLOC}-u1`, role: "user", type: "account", activeLocation: DSTLOC, userName: "موظف برلين", email: "de@x.com" });
const DM = dstMgr.body?.token, DE = dstEmp.body?.token;
await call(DM, "PUT", "/admin/settings",
  { timezone: "Europe/Berlin", daily_target_hours: 8, max_session_hours: 24, work_start: "09:00", late_grace_minutes: 15 });
const utcSec = (...a) => Date.UTC(...a) / 1000;
async function dstSession(startedAt) {
  const open = await call(DE, "POST", "/session/start");
  await call(DE, "POST", "/session/stop");
  await call(DM, "PATCH", `/admin/sessions/${open.body?.id}`,
    { started_at: startedAt, ended_at: startedAt + 3600, reason: "جلسة توقيت صيفي للاختبار" });
  return open.body?.id;
}
const winterId = await dstSession(utcSec(2026, 2, 20, 7, 30));
const summerId = await dstSession(utcSec(2026, 3, 10, 7, 30));
const dstFrom = utcSec(2026, 2, 19), dstTo = utcSec(2026, 3, 12);
const dstReport = await call(DM, "GET", `/admin/report?from=${dstFrom}&to=${dstTo}`);
const dstRow = dstReport.body?.employees?.find((e) => e.user_id === `${DSTLOC}-u1`);
check("DST: only the summer-time 09:30 counts as late across the change",
  dstRow?.late_days === 1 && Number(dstRow?.days_present) === 2,
  `(late_days ${JSON.stringify(dstRow?.late_days)}, days_present ${JSON.stringify(dstRow?.days_present)})`);
const dstList = await call(DM, "GET", `/admin/sessions?from=${dstFrom}&to=${dstTo}&user_id=${DSTLOC}-u1`);
const winterRow = dstList.body?.sessions?.find((x) => x.id === winterId);
const summerRow = dstList.body?.sessions?.find((x) => x.id === summerId);
check("DST: session detail uses each date's own offset",
  winterRow?.late_by_sec === null && summerRow?.late_by_sec === 900,
  `(winter ${JSON.stringify(winterRow?.late_by_sec)}, summer ${JSON.stringify(summerRow?.late_by_sec)})`);
await cleanupLocation(DSTLOC);

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

await cleanupLocation(P2LOC);

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

// Unpaid fixed window: recorded as a break when a manager edit puts a session over it —
// but only for windows that began after the policy was saved (break_policy_since). Checks
// that need an OLDER policy backdate break_policy_since through the local dev DB, and are
// skipped (with a SKIP line) when the smoke test runs against anything else.
// Riyadh is UTC+3 with no DST; fxMidnight is 00:00 local "yesterday" as UTC seconds.
const fxMidnight = Math.floor((t + 3 * 3600) / 86400) * 86400 - 86400 - 3 * 3600;
const fxPatch = (id, dayStart, fromH, toH, reason = "نافذة استراحة للاختبار") => call(FM, "PATCH", `/admin/sessions/${id}`,
  { started_at: dayStart + fromH * 3600, ended_at: dayStart + toH * 3600, reason });
async function fxSessionAt(dayStart) {
  const open = await call(FE, "POST", "/session/start");
  await call(FE, "POST", "/session/stop");
  await fxPatch(open.body?.id, dayStart, 9, 17);
  return open.body?.id;
}
async function fxBreakSec(id, dayStart) {
  const r = await call(FM, "GET", `/admin/sessions?from=${dayStart}&to=${dayStart + 86400}&user_id=${FXLOC}-u1`);
  return r.body?.sessions?.find((x) => x.id === id)?.break_sec;
}
await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false });
const fxUnpaidId = await fxSessionAt(fxMidnight);
check("a policy saved now does not reach back: an edit covering yesterday's window records nothing",
  (await fxBreakSec(fxUnpaidId, fxMidnight)) === 0, `(${await fxBreakSec(fxUnpaidId, fxMidnight)})`);

const fxOlder = await setPolicySince(FXLOC, fxMidnight - 5 * 86400);
if (fxOlder) {
  // Newly cover the window again (the previous bounds already covered it, so a same-bounds
  // edit would be skipped): shrink below 13:00, then extend back to 17:00.
  await fxPatch(fxUnpaidId, fxMidnight, 9, 12);
  await fxPatch(fxUnpaidId, fxMidnight, 9, 17);
  check("an unpaid fixed window is deducted from a session that covers it",
    (await fxBreakSec(fxUnpaidId, fxMidnight)) === 3600, `(${await fxBreakSec(fxUnpaidId, fxMidnight)})`);
  const fxRange = `from=${fxMidnight + 9 * 3600}&to=${fxMidnight + 17 * 3600}`;
  const fxReport = await call(FM, "GET", `/admin/report?${fxRange}`);
  check("report worked time excludes the unpaid window",
    fxReport.body?.employees?.find((e) => e.user_id === `${FXLOC}-u1`)?.worked_sec === 7 * 3600,
    `(${JSON.stringify(fxReport.body?.employees?.find((e) => e.user_id === `${FXLOC}-u1`))})`);

  // Moving the window on a day that already has one recorded must not deduct twice: at most
  // one fixed row per session per local day. The edits newly cover 15:00–16:00 (09:00–14:30
  // does not reach it), so the recorder does try the new window — and the day's row wins.
  await fxPolicy({ break_mode: "fixed", break_start: "15:00", break_end: "16:00", break_paid: false });
  await setPolicySince(FXLOC, fxMidnight);
  await fxPatch(fxUnpaidId, fxMidnight, 9, 14.5);
  await fxPatch(fxUnpaidId, fxMidnight, 9, 17);
  check("a moved window on an already-recorded day is not deducted a second time",
    (await fxBreakSec(fxUnpaidId, fxMidnight)) === 3600, `(${await fxBreakSec(fxUnpaidId, fxMidnight)})`);
  // Control: the same edits on a day with nothing recorded do record the new window.
  const fxCtlDay = fxMidnight - 4 * 86400;
  await setPolicySince(FXLOC, fxCtlDay);
  const fxCtlOpen = await call(FE, "POST", "/session/start");
  await call(FE, "POST", "/session/stop");
  await fxPatch(fxCtlOpen.body?.id, fxCtlDay, 9, 14.5);
  await fxPatch(fxCtlOpen.body?.id, fxCtlDay, 9, 17);
  check("…while the same edits on a day with nothing recorded record the new window",
    (await fxBreakSec(fxCtlOpen.body?.id, fxCtlDay)) === 3600, `(${await fxBreakSec(fxCtlOpen.body?.id, fxCtlDay)})`);

  await fxPolicy({ break_mode: "off" });
  check("switching the policy off does not rewrite a recorded day",
    (await fxBreakSec(fxUnpaidId, fxMidnight)) === 3600);
} else {
  console.log("  SKIP  past-day fixed-window deductions (need a local DB to backdate break_policy_since)");
}

// A paid window deducts nothing.
await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: true });
await setPolicySince(FXLOC, fxMidnight - 5 * 86400);
const fxPaidId = await fxSessionAt(fxMidnight - 86400);
check("a paid fixed window deducts nothing", (await fxBreakSec(fxPaidId, fxMidnight - 86400)) === 0);

// Live: a window running now. Run in a fixed-offset zone where it is about noon, so the
// window never straddles local midnight and these checks never skip.
{
  const nowS = Math.floor(Date.now() / 1000);
  let h = Math.round((12 * 3600 - (nowS % 86400)) / 3600);
  if (h > 14) h -= 24;
  if (h < -12) h += 24;
  const liveTz = h === 0 ? "UTC" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`; // Etc/GMT-3 = UTC+3
  const nowLocal = (((nowS + h * 3600) % 86400) + 86400) % 86400;
  const hhmm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}`;
  const winStart = Math.floor(nowLocal / 60) * 60 - 60;
  const livePolicy = { timezone: liveTz, break_mode: "fixed", break_start: hhmm(winStart), break_end: hhmm(winStart + 3600), break_paid: false };
  const winStartUtc = nowS - (nowLocal - winStart);

  // Saved one minute into the window: that window began before the policy existed.
  await fxPolicy(livePolicy);
  await call(FE, "POST", "/session/start");
  await sleep(2100);
  const late = await call(FE, "GET", "/me/status");
  check("a window already running when the policy is saved is not deducted",
    late.body?.fixed_break === null && late.body?.open_session?.break_sec === 0, `(${JSON.stringify(late.body)})`);
  if (await setPolicySince(FXLOC, winStartUtc - 60)) {
    // Changing the policy records windows that began under the old one first. Nothing
    // else runs the recorder between the backdate and this save.
    await fxPolicy({ ...livePolicy, break_mode: "off" });
    const kept = await call(FE, "GET", "/me/status");
    check("saving a new policy first records the window already running under the old one",
      kept.body?.open_session?.break_sec >= 2 && kept.body?.fixed_break?.starts_at === winStartUtc,
      `(${JSON.stringify(kept.body)})`);
    const liveStop = await call(FE, "POST", "/session/stop");
    check("stop clips a window that runs past it",
      liveStop.status === 200 && liveStop.body?.break_sec === liveStop.body?.duration_sec,
      `(break ${liveStop.body?.break_sec}, duration ${liveStop.body?.duration_sec})`);

    await fxPolicy(livePolicy);
    await setPolicySince(FXLOC, winStartUtc - 60);
    // A manager edit of an OPEN session inside a begun-but-unrecorded window: the edit
    // skips windows its old bounds already covered, so the window is recorded first.
    const edited = await call(FE, "POST", "/session/start");
    await sleep(1100);
    const editEnd = Math.floor(Date.now() / 1000);
    await call(FM, "PATCH", `/admin/sessions/${edited.body?.id}`,
      { started_at: edited.body?.started_at, ended_at: editEnd, reason: "إغلاق جلسة مفتوحة داخل النافذة" });
    const editedBreak = await fxBreakSec(edited.body?.id, edited.body?.started_at - 10);
    check("editing an open session keeps the window it is in",
      editedBreak === editEnd - edited.body?.started_at, `(break ${editedBreak}, duration ${editEnd - edited.body?.started_at})`);

    await call(FE, "POST", "/session/start");
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

    // The day's recorded fixed row plus an employee break (policy switched to flexible
    // mid-window) add up to more break than session; CSV Hours must still not go below 0.
    await fxPolicy({ ...livePolicy, break_mode: "flexible" });
    await call(FE, "POST", "/session/break/start");
    await sleep(1100);
    const over = await call(FE, "POST", "/session/stop");
    const overCsv = await call(FM, "GET", `/admin/export.csv?from=${over.body?.started_at}&to=${over.body?.ended_at + 1}`);
    const overCells = String(overCsv.body).split("\r\n")[1]?.match(/"(?:[^"]|"")*"/g) ?? [];
    check("CSV Hours is clamped at 0 when recorded breaks exceed the session",
      over.body?.break_sec > over.body?.duration_sec && overCells[4] === '"0.00"',
      `(break ${over.body?.break_sec}, duration ${over.body?.duration_sec}, row ${JSON.stringify(overCells)})`);
  } else {
    console.log("  SKIP  live fixed-window deductions (need a local DB to backdate break_policy_since)");
  }
  await call(FE, "POST", "/session/stop");
  await fxPolicy({ break_mode: "off" });
}

// A manager edit records only windows the NEW bounds newly cover, not ones already
// coverable under the old bounds — a later-added fixed policy must not silently rewrite
// a day a prior edit already fixed up under a different (e.g. off) policy.
const fxOldOpen = await call(FE, "POST", "/session/start");
await call(FE, "POST", "/session/stop");
const fxOldId = fxOldOpen.body?.id;
const fxOldDay = fxMidnight - 2 * 86400;
await fxPatch(fxOldId, fxOldDay, 9, 17, "تعديل قبل تفعيل النافذة");
await fxPolicy({ break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false });
if (await setPolicySince(FXLOC, fxMidnight - 5 * 86400)) {
  await fxPatch(fxOldId, fxOldDay, 9, 17 + 5 / 60, "تصحيح بسيط لوقت الانتهاء");
  check("an edit that already covered a window under the old policy does not re-record it",
    (await fxBreakSec(fxOldId, fxOldDay)) === 0, `(${await fxBreakSec(fxOldId, fxOldDay)})`);

  const fxNewOpen = await call(FE, "POST", "/session/start");
  await call(FE, "POST", "/session/stop");
  const fxNewId = fxNewOpen.body?.id;
  const fxNewDay = fxMidnight - 3 * 86400;
  await fxPatch(fxNewId, fxNewDay, 9, 12, "جلسة صباحية لا تغطي النافذة");
  await fxPatch(fxNewId, fxNewDay, 9, 17, "تمديد الجلسة ليغطي النافذة");
  check("an edit that newly covers a window records it",
    (await fxBreakSec(fxNewId, fxNewDay)) === 3600, `(${await fxBreakSec(fxNewId, fxNewDay)})`);
} else {
  console.log("  SKIP  edit-coverage fixed-window checks (need a local DB to backdate break_policy_since)");
}

await cleanupLocation(FXLOC);

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
