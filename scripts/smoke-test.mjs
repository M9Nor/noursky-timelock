/**
 * End-to-end smoke test for the TimeClock API.
 * Simulates GHL SSO by encrypting a fake user payload with the same
 * CryptoJS AES passphrase format that GHL uses.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=... npm run test:smoke
 *
 * Uses a random location id per run, so it never touches real client data.
 *
 * Against production the test-signed webhook checks cannot run (production trusts only GHL's
 * real key): one probe records "refused (production target)" and the rest are SKIPped.
 *
 * To also check that install/uninstall events from another app are ignored, run the local
 * API with the app id on the command line (it overrides .env; .env is not edited) and
 * tell this test the same id:
 *   GHL_APP_ID=test-app node --env-file=.env src/server.js
 *   GHL_APP_ID=test-app BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=... npm run test:smoke
 * Without GHL_APP_ID here, that one check prints SKIP.
 */
import CryptoJS from "crypto-js";
import { readFileSync } from "node:fs";
import { signTestWebhook } from "./fixtures/ghl-test-webhook-key.mjs";

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
    for (const table of ["activity_events", "activity_alerts", "ghl_installs", "breaks", "edits_log", "sessions", "employees", "settings"]) {
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

/** POST a fake GHL webhook; `sign: false` sends no signature, `tamper` changes the body after signing. */
async function ghlWebhook(payload, { sign = true, tamper = false } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (sign) headers["X-GHL-Signature"] = signTestWebhook(raw);
  const r = await fetch(`${BASE}/webhooks/events`, { method: "POST", headers, body: tamper ? raw.replace(/}$/, ',"x":1}') : raw });
  let body; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

/** Run one query against the local dev DB; null when there is no local DB. */
async function localRows(sql, params) {
  let rows = null;
  const { skipped } = await withLocalDb(async (conn) => { [rows] = await conn.execute(sql, params); });
  return skipped ? null : rows;
}

// Marks a location as connected the way /oauth/callback does: installed, with the activity scope.
const connectActivity = (loc) => localRows(
  `INSERT INTO ghl_installs (location_id, scopes, installed_at, updated_at)
   VALUES (:loc, 'users.readonly conversations/message.readonly', :t, :t)
   ON DUPLICATE KEY UPDATE scopes = VALUES(scopes), installed_at = VALUES(installed_at), uninstalled_at = NULL`,
  { loc, t: Math.floor(Date.now() / 1000) });

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
  (await fxPolicy({ break_mode: "fixed", break_start: null, break_end: null })).body?.error === "INVALID_BREAK_WINDOW");
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

// --- "Today" on the employee screen is the location's calendar day, not the last 24 hours.
// Riyadh (UTC+3, no DST). A session that ended before local midnight is within the last
// 24h but belongs to yesterday, so today's worked_sec must not include it.
const TDLOC = `${LOC}-td`;
const tdMgr = await sso({ userId: `${TDLOC}-m1`, role: "admin", type: "account", activeLocation: TDLOC, userName: "مدير اليوم", email: "tdm@x.com" });
const tdEmp = await sso({ userId: `${TDLOC}-u1`, role: "user", type: "account", activeLocation: TDLOC, userName: "موظف اليوم", email: "tde@x.com" });
const TDM = tdMgr.body?.token, TDE = tdEmp.body?.token;
await call(TDM, "PUT", "/admin/settings", { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: null, late_grace_minutes: 15, note_on_stop: "off" });
const tdNow = Math.floor(Date.now() / 1000);
const tdMidnight = Math.floor((tdNow + 3 * 3600) / 86400) * 86400 - 3 * 3600; // today 00:00 Riyadh
const tdOpen = await call(TDE, "POST", "/session/start");
await call(TDE, "POST", "/session/stop");
await call(TDM, "PATCH", `/admin/sessions/${tdOpen.body?.id}`,
  { started_at: tdMidnight - 2 * 3600, ended_at: tdMidnight - 3600, reason: "جلسة مساء أمس للاختبار" });
const tdStatus = await call(TDE, "GET", "/me/status");
check("today's total excludes yesterday evening's session",
  tdStatus.status === 200 && tdStatus.body?.worked_sec === 0, `(worked_sec ${JSON.stringify(tdStatus.body?.worked_sec)})`);
check("status says when today ends (next local midnight)",
  tdStatus.body?.day_ends_at === tdMidnight + 86400, `(${JSON.stringify(tdStatus.body?.day_ends_at)} vs ${tdMidnight + 86400})`);
// A session across midnight counts only its part after midnight (the edited end must be in
// the past, so the after-midnight part is up to 20 min, capped by the current local time).
const tdAfter = Math.min(1200, tdNow - tdMidnight - 60);
if (tdAfter > 0) {
  const tdCross = await call(TDE, "POST", "/session/start");
  await call(TDE, "POST", "/session/stop");
  await call(TDM, "PATCH", `/admin/sessions/${tdCross.body?.id}`,
    { started_at: tdMidnight - 1800, ended_at: tdMidnight + tdAfter, reason: "جلسة عبر منتصف الليل للاختبار" });
  const tdCrossStatus = await call(TDE, "GET", "/me/status");
  check("a session across midnight counts only its part after midnight",
    tdCrossStatus.body?.worked_sec === tdAfter, `(worked_sec ${JSON.stringify(tdCrossStatus.body?.worked_sec)}, expected ${tdAfter})`);
} else {
  console.log("  SKIP  across-midnight today check (less than a minute past local midnight)");
}
await cleanupLocation(TDLOC);

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

// --- Activity monitoring (phase A): settings, connection status, webhooks, OAuth. ---
const AWLOC = `${LOC}-aw`;
const awMgr = await sso({ userId: `${AWLOC}-m1`, role: "admin", type: "account", activeLocation: AWLOC, userName: "مدير النشاط", email: "awm@x.com" });
const awEmp = await sso({ userId: `${AWLOC}-u1`, role: "user", type: "account", activeLocation: AWLOC, userName: "موظف النشاط", email: "awe@x.com" });
const AWM = awMgr.body?.token, AWE = awEmp.body?.token;
const awBase = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: null, late_grace_minutes: 15, note_on_stop: "off", break_mode: "off" };
const awPolicy = (extra) => call(AWM, "PUT", "/admin/settings", { ...awBase, ...extra });

const awDefaults = await call(AWM, "GET", "/admin/settings");
check("activity monitoring is off by default with a 30-minute idle threshold",
  awDefaults.body?.activity_monitoring === false && awDefaults.body?.idle_minutes === 30 && awDefaults.body?.activity_monitoring_since === null,
  `(${JSON.stringify({ m: awDefaults.body?.activity_monitoring, i: awDefaults.body?.idle_minutes, s: awDefaults.body?.activity_monitoring_since })})`);
const awOnAt = Math.floor(Date.now() / 1000);
const awOn = await awPolicy({ activity_monitoring: true, idle_minutes: 45 });
check("switching monitoring on saves the threshold and stamps when it started",
  awOn.status === 200 && awOn.body?.activity_monitoring === true && awOn.body?.idle_minutes === 45
    && Math.abs(Number(awOn.body?.activity_monitoring_since) - awOnAt) <= 5,
  `(${JSON.stringify({ m: awOn.body?.activity_monitoring, i: awOn.body?.idle_minutes, s: awOn.body?.activity_monitoring_since })})`);
// Backdate the stamp so a restamp-on-every-save regression is visible (two stamps taken
// milliseconds apart would compare equal).
const awBackdated = awOnAt - 3600;
const awBackdate = await withLocalDb((conn) =>
  conn.execute("UPDATE settings SET activity_monitoring_since = ? WHERE location_id = ?", [awBackdated, AWLOC]));
if (awBackdate.skipped) {
  console.log(`  SKIP  monitoring-since stamp checks (${awBackdate.skipped})`);
} else {
  const awAgain = await awPolicy({ activity_monitoring: true, idle_minutes: 30 });
  check("saving again while monitoring stays on keeps the original start",
    Number(awAgain.body?.activity_monitoring_since) === awBackdated,
    `(${JSON.stringify({ s: awAgain.body?.activity_monitoring_since, want: awBackdated })})`);
  const awOff = await awPolicy({ activity_monitoring: false, idle_minutes: 30 });
  check("switching monitoring off leaves the stamp unchanged",
    awOff.body?.activity_monitoring === false && Number(awOff.body?.activity_monitoring_since) === awBackdated,
    `(${JSON.stringify({ m: awOff.body?.activity_monitoring, s: awOff.body?.activity_monitoring_since })})`);
  const awReOnAt = Math.floor(Date.now() / 1000);
  const awReOn = await awPolicy({ activity_monitoring: true, idle_minutes: 30 });
  check("switching monitoring back on restamps the start to now",
    awReOn.body?.activity_monitoring === true && Math.abs(Number(awReOn.body?.activity_monitoring_since) - awReOnAt) <= 5,
    `(${JSON.stringify({ s: awReOn.body?.activity_monitoring_since, now: awReOnAt })})`);
}
check("idle threshold outside 1–240 → 400",
  (await awPolicy({ activity_monitoring: true, idle_minutes: 0 })).body?.error === "INVALID_IDLE_MINUTES");
check("non-boolean monitoring toggle → 400",
  (await awPolicy({ activity_monitoring: "yes" })).body?.error === "INVALID_ACTIVITY_MONITORING");
const awConn0 = await call(AWM, "GET", "/admin/ghl-connection");
check("a location that never installed reports no connection",
  awConn0.status === 200 && awConn0.body?.installed === false && awConn0.body?.has_activity_scope === false
    && awConn0.body?.last_event_at === null && awConn0.body?.events_24h === 0,
  `(${JSON.stringify(awConn0.body)})`);

// Webhooks. Signed with the test key, which a development/test server accepts (production refuses it).
const AWAPP = process.env.GHL_APP_ID || "test-app";
const awMsg = (extra) => ({
  type: "OutboundMessage", locationId: AWLOC, userId: `${AWLOC}-u1`, messageType: "SMS",
  source: "app", dateAdded: new Date().toISOString(), body: "محتوى لا يجب أن يُخزَّن", ...extra,
});
check("an unsigned webhook → 401",
  (await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w0` }), { sign: false })).body?.error === "WEBHOOK_BAD_SIGNATURE");
check("a webhook whose body changed after signing → 401",
  (await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w0` }), { tamper: true })).status === 401);

// One probe decides whether the target accepts the test signing key. A production server
// answers 401 (it only trusts GHL's real key), so the signed-webhook checks cannot run there.
const awInstall = await ghlWebhook({ type: "INSTALL", locationId: AWLOC, companyId: "comp-1", appId: AWAPP, webhookId: `${AWLOC}-install` });
const awAcceptsTestKey = !(awInstall.status === 401 && awInstall.body?.error === "WEBHOOK_BAD_SIGNATURE");
if (!awAcceptsTestKey) {
  check("a test-key-signed webhook is refused (production target)", true);
  console.log("  SKIP  signed-webhook checks (target refuses the test signing key, as production must)");
} else {
  const awConn1 = await call(AWM, "GET", "/admin/ghl-connection");
  check("a signed install marks the location connected and records the event time",
    awInstall.status === 200 && awConn1.body?.installed === true && typeof awConn1.body?.last_event_at === "number",
    `(${awInstall.status} ${JSON.stringify(awConn1.body)})`);

  if (process.env.GHL_APP_ID) {
    // GHL signs every app's events with one key; the server must only trust its own appId.
    const awForeign = await ghlWebhook({ type: "UNINSTALL", locationId: AWLOC, appId: `${AWAPP}-other`, webhookId: `${AWLOC}-foreign` });
    check("a signed uninstall carrying another app's appId is ignored",
      awForeign.status === 200 && (await call(AWM, "GET", "/admin/ghl-connection")).body?.installed === true,
      `(${awForeign.status})`);
  } else {
    console.log("  SKIP  foreign-appId check (run the API and this test with GHL_APP_ID=test-app; see header)");
  }

  await awPolicy({ activity_monitoring: false });
  const awOffPost = await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w1` }));
  check("activity is not stored while monitoring is off",
    awOffPost.status === 200 && (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h === 0,
    `(${awOffPost.status})`);

  await awPolicy({ activity_monitoring: true });
  const awStored = await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w2` }));
  check("activity is stored once monitoring is on",
    awStored.status === 200 && (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h === 1);
  const awRetry = await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w2` }));
  check("a retried webhook (same webhookId) is stored once",
    awRetry.status === 200 && (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h === 1,
    `(${awRetry.status})`);

  await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w3`, messageType: "CALL" }));
  const awRows = await localRows(
    "SELECT * FROM activity_events WHERE location_id = :loc ORDER BY webhook_id",
    { loc: AWLOC });
  if (awRows) {
    // Ordered by webhook_id (w2 then w3); ORDER BY an ENUM would sort by declaration order.
    check("stored activity keeps kind, type and source — and no content column exists",
      awRows.length === 2 && awRows[0].kind === "message" && awRows[1].kind === "call"
        && awRows[0].message_type === "SMS" && awRows[0].source === "app"
        && awRows[0].user_id === `${AWLOC}-u1` && !("body" in awRows[0]),
      `(${JSON.stringify(awRows)})`);
    await localRows(
      `INSERT INTO activity_events (id, location_id, user_id, occurred_at, kind, webhook_id, created_at)
       VALUES (UUID(), :loc, :uid, :old, 'message', :wid, :old)`,
      { loc: AWLOC, uid: `${AWLOC}-u1`, old: Math.floor(Date.now() / 1000) - 91 * 86400, wid: `${AWLOC}-old` });
    await call(AWM, "GET", "/admin/ghl-connection");
    const awOld = await localRows("SELECT COUNT(*) AS n FROM activity_events WHERE webhook_id = :wid", { wid: `${AWLOC}-old` });
    check("activity older than 90 days is purged", Number(awOld?.[0]?.n) === 0, `(${JSON.stringify(awOld)})`);
  } else {
    console.log("  SKIP  stored-activity and retention checks (need a local DB)");
  }

  // The same message redelivered (e.g. via another app) arrives with a new webhookId.
  const awBefore = (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h;
  await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w4a`, messageId: `${AWLOC}-msg1` }));
  await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w4b`, messageId: `${AWLOC}-msg1` }));
  const awAfter = (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h;
  check("the same messageId under two different webhookIds is stored once",
    Number.isInteger(awBefore) && awAfter === awBefore + 1, `(${awBefore} -> ${awAfter})`);

  await ghlWebhook({ type: "UNINSTALL", locationId: AWLOC, appId: AWAPP, webhookId: `${AWLOC}-uninstall` });
  check("a signed uninstall marks the location disconnected",
    (await call(AWM, "GET", "/admin/ghl-connection")).body?.installed === false);
}

// --- Not-clocked-in alert (activity phase B, spec §5.3). Own location, UTC, needs the test key.
const NCLOC = `${LOC}-nc`;
const ncMgr = await sso({ userId: `${NCLOC}-m1`, role: "admin", type: "account", activeLocation: NCLOC, userName: "مدير التنبيهات", email: "ncm@x.com" });
const ncE1 = await sso({ userId: `${NCLOC}-u1`, role: "user", type: "account", activeLocation: NCLOC, userName: "موظف أول", email: "nc1@x.com" });
const ncE2 = await sso({ userId: `${NCLOC}-u2`, role: "user", type: "account", activeLocation: NCLOC, userName: "موظف تاني", email: "nc2@x.com" });
const NCM = ncMgr.body?.token, NC1 = ncE1.body?.token, NC2 = ncE2.body?.token;
const ncNow = Math.floor(Date.now() / 1000);
const ncTod = ncNow % 86400;
let ncSeq = 0;
const ncEvent = (userId, at = Math.floor(Date.now() / 1000), key = ++ncSeq) => {
  const p = { type: "OutboundMessage", locationId: NCLOC, messageType: "SMS", source: "app",
    dateAdded: new Date(at * 1000).toISOString(), webhookId: `${NCLOC}-w${key}`, messageId: `${NCLOC}-m${key}` };
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
  await ncEvent(`${NCLOC}-u2`, ncNow - 5400);
  check("an event timed before a session that already ended opens nothing (late delivery)",
    (await ncOpenFor(`${NCLOC}-u2`)).length === 0, `(${JSON.stringify(await ncOpenFor(`${NCLOC}-u2`))})`);

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
  await ncEvent(`${NCLOC}-u2`, Math.floor(Date.now() / 1000), 9001);
  check("the same employee inside working hours does get an alert (the checks above are not vacuous)",
    (await ncOpenFor(`${NCLOC}-u2`)).length === 1);

  check("an employee cannot list alerts", (await call(NC1, "GET", "/admin/alerts")).status === 403);
  check("an unknown status → 400", (await call(NCM, "GET", "/admin/alerts?status=maybe")).body?.error === "INVALID_STATUS");
  const ncList = await call(NCM, "GET", "/admin/alerts");
  check("the alert list reports the location timezone and server time",
    ncList.body?.timezone === "UTC" && Number.isInteger(ncList.body?.server_time));

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
  await ncEvent(`${NCLOC}-u2`, Math.floor(Date.now() / 1000), 9001); // GHL redelivers the same message
  check("a duplicate delivery of the event that opened a dismissed alert opens nothing",
    (await ncOpenFor(`${NCLOC}-u2`)).length === 0);
  await cleanupLocation(`${NCLOC}-x`);

  const ncA1 = (await call(NC1, "GET", "/me/alerts")).body?.alerts?.[0];
  check("the employee notes their alert before clocking in",
    (await call(NC1, "POST", `/me/alerts/${ncA1?.id}/note`, { note: "رح ابلّش هلّق" })).status === 200);
  await call(NC1, "POST", "/session/start");
  check("clocking in resolves the employee's alert", (await ncOpenFor(`${NCLOC}-u1`)).length === 0);
  const ncResolved = ((await call(NCM, "GET", "/admin/alerts?status=resolved")).body?.alerts ?? [])
    .find((a) => a.user_id === `${NCLOC}-u1`);
  check("the resolved alert says it was resolved by clocking in",
    ncResolved?.status === "resolved" && ncResolved?.resolution === "clocked_in", `(${JSON.stringify(ncResolved)})`);
  check("the resolved alert keeps the employee's note and has a resolved_at",
    ncResolved?.employee_note === "رح ابلّش هلّق" && Number.isInteger(ncResolved?.resolved_at),
    `(${JSON.stringify(ncResolved)})`);
  await call(NC1, "POST", "/session/stop");
}
await cleanupLocation(NCLOC);

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
  check("no idle time is shown while the location is not connected", (await idMe())?.idle_sec === null);

  await connectActivity(IDLOC);
  const idIdle = await idMe();
  check("connected with no event at all, an open session with no activity for an hour shows about an hour idle",
    Math.abs(Number(idIdle?.idle_sec) - 3600) <= 10 && idIdle?.last_activity_at === null, `(${JSON.stringify(idIdle)})`);

  await idEvent(`${IDLOC}-stranger`); // someone who never opened TimeClock
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

  const idEditEnd = Math.floor(Date.now() / 1000);
  const idEdit = await call(IDM, "PATCH", `/admin/sessions/${idS?.id}`,
    { started_at: idEditEnd - 600, ended_at: idEditEnd, reason: "تقصير للاختبار" });
  const idS2 = (await call(IDM, "GET", `/admin/sessions?from=${idT - 86400}&to=${idT + 60}&user_id=${IDLOC}-u1`)).body?.sessions?.[0];
  check("a manager edit recomputes the summary",
    idEdit.status === 200 && idS2?.longest_idle_sec != null && idS2.longest_idle_sec <= 600
      && idS2?.activity_count === 1, `(${JSON.stringify(idS2)})`);

  await localRows("DELETE FROM activity_events WHERE location_id = :loc", { loc: IDLOC });
  await call(IDE, "POST", "/session/start");
  check("connected with no event in 24 hours idle is still shown", (await idMe())?.idle_sec != null);
  await call(IDE, "POST", "/session/stop");
  const idSilent = (await call(IDM, "GET", `/admin/sessions?from=${idT - 86400}&to=${idEditEnd + 600}&user_id=${IDLOC}-u1`)).body?.sessions
    ?.find((x) => x.id !== idS?.id);
  check("connected with no event in the 24 h before it ended, a stopped session stores a zero-activity summary",
    idSilent && idSilent.ended_at != null && idSilent.activity_count === 0 && idSilent.longest_idle_sec != null,
    `(${JSON.stringify(idSilent)})`);

  // A manager edit refills the summary however old the session is (summaries are kept forever).
  const idOldStart = idT - 10 * 86400;
  await localRows("UPDATE settings SET activity_monitoring_since = :s WHERE location_id = :loc", { s: idT - 20 * 86400, loc: IDLOC });
  await localRows(
    `UPDATE sessions SET started_at = :s, ended_at = :e, duration_sec = 3600, activity_count = NULL,
            last_activity_at = NULL, longest_idle_sec = NULL WHERE id = :id`,
    { s: idOldStart, e: idOldStart + 3600, id: idSilent?.id });
  await localRows(
    `INSERT INTO activity_events (id, location_id, user_id, occurred_at, kind, message_type, source, webhook_id, created_at)
     VALUES (:id, :loc, :uid, :at, 'message', 'SMS', 'app', :wh, :t)`,
    { id: crypto.randomUUID(), loc: IDLOC, uid: `${IDLOC}-u1`, at: idOldStart + 1800, wh: `${IDLOC}-old-w`, t: idT });
  const idOldEdit = await call(IDM, "PATCH", `/admin/sessions/${idSilent?.id}`,
    { started_at: idOldStart + 600, ended_at: idOldStart + 3000, reason: "تعديل جلسة قديمة" });
  const idOld = (await call(IDM, "GET", `/admin/sessions?from=${idOldStart - 86400}&to=${idOldStart + 86400}&user_id=${IDLOC}-u1`)).body?.sessions
    ?.find((x) => x.id === idSilent?.id);
  check("a manager edit of a session that ended over 7 days ago still stores its summary",
    idOldEdit.status === 200 && idOld?.activity_count === 1 && idOld?.longest_idle_sec != null,
    `(${JSON.stringify(idOld)})`);

  await call(IDM, "PUT", "/admin/settings", { activity_monitoring: false });
  check("with monitoring off live has no idle threshold", (await idLive())?.idle_minutes === null);
}
await cleanupLocation(IDLOC);
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
  check("no idle alert while the location is not connected", (await icIdle()).length === 0);

  await connectActivity(ICLOC);
  const icA = (await icIdle())[0];
  check("connected, an idle alert opens once the threshold is passed even with no event at all",
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

  // Final review I1: an event delivered after the stretch was already ended (session end, or a
  // newer event) but dated inside it shortens it the same way.
  const icClear = () => localRows("DELETE FROM activity_events WHERE location_id = :loc AND user_id = :uid",
    { loc: ICLOC, uid: `${ICLOC}-u1` });
  await icClear();
  await call(ICE, "POST", "/session/start");
  await icBackdate(600);
  const icE = (await icIdle()).find((a) => a.to_at === null);
  await call(ICE, "POST", "/session/stop");
  const icEs = (await icIdle()).find((a) => a.id === icE?.id);
  check("(precondition) the stopped session's idle alert is open with its end set",
    icE && icEs?.status === "open" && icEs.to_at != null, `(${JSON.stringify(icEs)})`);
  await icEvent(`${ICLOC}-u1`, Number(icE?.from_at) + 30);
  const icEr = (await icIdle("resolved")).find((a) => a.id === icE?.id);
  check("a late event delivered after the session ended resolves the alert as late activity",
    icEr?.resolution === "late_activity" && Number(icEr.to_at) === Number(icE?.from_at) + 30, `(${JSON.stringify(icEr)})`);

  await icClear();
  await call(ICE, "POST", "/session/start");
  await icBackdate(600);
  const icF = (await icIdle()).find((a) => a.to_at === null);
  const icFrom = Number(icF?.from_at);
  const icFNow = async (status = "open") => (await icIdle(status)).find((a) => a.id === icF?.id);
  await icEvent(`${ICLOC}-u1`, icFrom + 300);
  check("(precondition) a newer event ended the stretch at +300 s", Number((await icFNow())?.to_at) === icFrom + 300);
  await icEvent(`${ICLOC}-u1`, icFrom + 90);
  const icF2 = await icFNow();
  check("an out-of-order older event shortens an ended stretch that is still over the threshold",
    icF2?.status === "open" && Number(icF2.to_at) === icFrom + 90, `(${JSON.stringify(icF2)})`);
  await icEvent(`${ICLOC}-u1`, icFrom + 30);
  const icF3 = await icFNow("resolved");
  check("an out-of-order event that leaves it under the threshold resolves it as late activity",
    icF3?.resolution === "late_activity" && Number(icF3.to_at) === icFrom + 30, `(${JSON.stringify(icF3)})`);

  // Final review I2 / I3: switching monitoring off ends ongoing idle alerts; the employee's
  // poll only needs its own sessions.
  const icOn = (await icIdle()).find((a) => a.to_at === null);
  check("(precondition) an ongoing idle alert exists before monitoring is switched off", Boolean(icOn),
    `(${JSON.stringify(await icIdle())})`);
  check("(precondition) the employee sees it", (await icMine()).some((a) => a.id === icOn?.id));
  await call(ICM, "PUT", "/admin/settings", { activity_monitoring: false });
  const icOff = (await call(ICM, "GET", "/admin/alerts?status=open")).body?.alerts?.find((a) => a.id === icOn?.id);
  check("switching monitoring off ends the ongoing idle alert", icOff && icOff.to_at != null, `(${JSON.stringify(icOff)})`);
  check("and it leaves the employee's list", !(await icMine()).some((a) => a.id === icOn?.id));
  await call(ICE, "POST", "/session/stop");
}
await cleanupLocation(ICLOC);

const awBig = await ghlWebhook({ type: "OutboundMessage", locationId: AWLOC, pad: "x".repeat(300 * 1024) }, { sign: false });
check("a webhook over 256 KB → 413 PAYLOAD_TOO_LARGE",
  awBig.status === 413 && awBig.body?.error === "PAYLOAD_TOO_LARGE", `(${awBig.status} ${JSON.stringify(awBig.body)})`);

// OAuth callback. The local .env has no GHL_CLIENT_ID, so a code cannot be exchanged here.
const awNoCode = await fetch(`${BASE}/oauth/callback`, { headers: { "Accept-Language": "ar" } });
check("the OAuth callback without a code shows an error page",
  awNoCode.status === 400 && (await awNoCode.text()).includes("أعد تثبيت التطبيق"));
const awBadCode = await fetch(`${BASE}/oauth/callback?code=test-code`, { headers: { "Accept-Language": "ar" } });
const awBadCodeText = await awBadCode.text();
check("the OAuth callback with a bad code shows an Arabic error page (503 unconfigured / 502 refused)",
  (awBadCode.status === 503 && awBadCodeText.includes("غير مُعدّ")) ||
  (awBadCode.status === 502 && awBadCodeText.includes("GHL رفض")));
await cleanupLocation(AWLOC);

// --- Language (bilingual spec). Own location.
const LGLOC = `${LOC}-lg`;
const lgSso = (uid, role) => sso({ userId: `${LGLOC}-${uid}`, role, type: "account", activeLocation: LGLOC, userName: uid, email: `${uid}@x.com` });
const lgM = await lgSso("m1", "admin"), lgE = await lgSso("u1", "user");
check("a new user starts in the company language (Arabic by default)", lgE.body?.user?.locale === "ar", `(${JSON.stringify(lgE.body?.user)})`);
const lgSet = await call(lgM.body?.token, "PUT", "/admin/settings", { locale: "en" });
check("the manager sets the company language", lgSet.body?.locale === "en", `(${lgSet.status} ${JSON.stringify(lgSet.body?.error)})`);
check("users follow the company language", (await lgSso("u1", "user")).body?.user?.locale === "en");
check("a missing locale keeps the company language", (await call(lgM.body?.token, "PUT", "/admin/settings", { late_grace_minutes: 10 })).body?.locale === "en");
check("an unknown company language → 400", (await call(lgM.body?.token, "PUT", "/admin/settings", { locale: "fr" })).body?.error === "INVALID_LOCALE");
const lgMine = await call(lgE.body?.token, "PUT", "/me/locale", { locale: "ar" });
check("a user picks their own language", lgMine.status === 200 && lgMine.body?.locale === "ar");
check("the personal choice wins at the next login", (await lgSso("u1", "user")).body?.user?.locale === "ar");
check("clearing it follows the company again", (await call(lgE.body?.token, "PUT", "/me/locale", { locale: null })).body?.locale === "en");
check("an unknown personal language → 400", (await call(lgE.body?.token, "PUT", "/me/locale", { locale: "fr" })).body?.error === "INVALID_LOCALE");
check("a body without locale → 400", (await call(lgE.body?.token, "PUT", "/me/locale", {})).body?.error === "INVALID_LOCALE");
const lgInstallEn = await fetch(`${BASE}/oauth/callback`, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
const lgInstallEnText = await lgInstallEn.text();
check("the install page speaks English to an English browser",
  lgInstallEn.status === 400 && lgInstallEnText.includes('lang="en"') && lgInstallEnText.includes("Reinstall the app"));
const lgInstallAr = await (await fetch(`${BASE}/oauth/callback`, { headers: { "Accept-Language": "ar-SY,ar;q=0.9,en;q=0.5" } })).text();
check("the install page speaks Arabic to an Arabic browser", lgInstallAr.includes('dir="rtl"') && lgInstallAr.includes("أعد تثبيت التطبيق"));
await cleanupLocation(LGLOC);

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
