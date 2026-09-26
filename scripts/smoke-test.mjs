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
