/**
 * NourSky TimeClock — Node.js API (Hostinger Cloud · Managed Node.js)
 * Stack: Hono + @hono/node-server + mysql2
 * GHL Private Marketplace App · Custom Page + SSO (Shared Secret)
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import mysql from "mysql2/promise";
import { createHash, createDecipheriv, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { localZone, localDate, wallToUtc, fixedWindows, localDayBounds } from "./tz.js";
import { bodyLimit } from "hono/body-limit";
import { verifyGhlSignature, parseWebhook, testKeyAllowed, isForOurApp, activityDedupeKey } from "./ghlWebhook.js";
import { exchangeCode } from "./ghlOAuth.js";
import { encryptToken } from "./tokenCrypto.js";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const REQUIRED = ["DB_NAME", "DB_USER", "DB_PASSWORD", "GHL_SHARED_SECRET", "SESSION_SECRET"];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`[config] Missing env var: ${k}`); process.exit(1); }
}
const env = process.env;
const SESSION_TTL = 12 * 3600;
const AUTO_CLOSE_EVERY_MS = 15 * 60 * 1000;

const pool = mysql.createPool({
  host: env.DB_HOST || "localhost",
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: 5,
  namedPlaceholders: true,
  decimalNumbers: true,
  supportBigNumbers: true,
  charset: "utf8mb4",
  timezone: "Z",
});
// FROM_UNIXTIME / DATE() must work in UTC; timezone offsets are applied explicitly.
pool.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));

const now = () => Math.floor(Date.now() / 1000);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

async function q(sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

function intParam(c, key, fallback) {
  const v = c.req.query(key);
  if (v === undefined) {
    if (fallback === undefined) throw new HttpError(400, `MISSING_${key.toUpperCase()}`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `INVALID_${key.toUpperCase()}`);
  return n;
}

/* ------------------------------------------------------------------ */
/* GHL SSO decryption (CryptoJS AES passphrase format: "Salted__")     */
/* ------------------------------------------------------------------ */

function decryptSSO(encrypted, secret) {
  const raw = Buffer.from(encrypted, "base64");
  if (raw.subarray(0, 8).toString("latin1") !== "Salted__") throw new HttpError(400, "SSO_BAD_FORMAT");
  const salt = raw.subarray(8, 16);
  const ct = raw.subarray(16);
  const pass = Buffer.from(secret, "utf8");

  // OpenSSL EVP_BytesToKey (MD5) → 32-byte key + 16-byte IV
  let prev = Buffer.alloc(0);
  let derived = Buffer.alloc(0);
  while (derived.length < 48) {
    prev = createHash("md5").update(Buffer.concat([prev, pass, salt])).digest();
    derived = Buffer.concat([derived, prev]);
  }
  try {
    const d = createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32, 48));
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch {
    throw new HttpError(401, "SSO_DECRYPT_FAILED");
  }
}

/* ------------------------------------------------------------------ */
/* Our own session token (HMAC-SHA256)                                 */
/* ------------------------------------------------------------------ */

function signToken(claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(header) {
  const token = (header || "").replace(/^Bearer\s+/i, "");
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new HttpError(401, "UNAUTHORIZED");
  const expected = createHmac("sha256", env.SESSION_SECRET).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new HttpError(401, "UNAUTHORIZED");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (claims.exp < now()) throw new HttpError(401, "TOKEN_EXPIRED");
  return claims;
}

const authed = async (c, next) => {
  c.set("claims", verifyToken(c.req.header("Authorization")));
  await next();
};
const managerOnly = async (c, next) => {
  if (c.get("claims").role !== "manager") throw new HttpError(403, "FORBIDDEN");
  await next();
};

/* ------------------------------------------------------------------ */
/* Shared SQL                                                          */
/* ------------------------------------------------------------------ */

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

async function getSettings(loc) {
  const rows = await q("SELECT * FROM settings WHERE location_id = :loc", { loc });
  const st = rows[0];
  // TINYINT(1) arrives as 0/1; the API speaks booleans.
  return st
    ? {
      ...st,
      breaks_enabled: Boolean(st.breaks_enabled),
      break_paid: Boolean(st.break_paid),
      activity_monitoring: Boolean(st.activity_monitoring),
    }
    : null;
}

const NOTE_POLICIES = ["off", "optional", "required"];
const BREAK_MODES = ["off", "fixed", "flexible"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Today's fixed break window (local date of `t`), or null when the mode isn't fixed or
 * today's window began before the policy was saved (it never applies to that window).
 */
function todayFixedBreak(st, t) {
  if (st?.break_mode !== "fixed" || !st.break_start || !st.break_end) return null;
  const day = localDate(st.timezone, t);
  const startsAt = wallToUtc(st.timezone, day, st.break_start);
  if (st.break_policy_since != null && startsAt < Number(st.break_policy_since)) return null;
  return {
    starts_at: startsAt,
    ends_at: wallToUtc(st.timezone, day, st.break_end),
    paid: Boolean(st.break_paid),
  };
}

// Rows of kind 'fixed' on one session within one local day's UTC bounds.
const FIXED_ON_DAY = `SELECT 1 FROM breaks
   WHERE session_id = :sid AND kind = 'fixed' AND started_at >= :dayStart AND started_at < :dayEnd`;

/**
 * Unpaid fixed windows are written as `breaks` rows (kind 'fixed') once the window has
 * begun for a session, so every worked-time query deducts them like any other break and
 * a later policy change never rewrites a recorded day. Rows hold the whole window; reads
 * clip it to the session.
 *
 * At most ONE fixed row per session per local day: the first window recorded wins, so a
 * manager who moves the window on a day that already has one recorded never gets the day
 * deducted twice. The INSERT … SELECT … WHERE NOT EXISTS enforces that in SQL, so it holds
 * for concurrent recorders too; INSERT IGNORE on ux_fixed_window keeps it idempotent.
 * A window that began before the policy was saved (`break_policy_since`) is never
 * recorded: a policy applies from the moment it is saved, not to earlier windows.
 *
 * `exec(sql, params) → rows` runs the SQL (defaults to the pool via `q`; a manager edit
 * passes the transaction's connection so the edit and its recorded windows commit
 * atomically). `except`, when given, is the session's bounds *before* the edit — a window
 * that already overlapped them was recordable under the old bounds too, so it is skipped
 * here rather than re-recorded under whatever policy happens to be live today.
 */
async function recordFixedBreaks(session, st, t, { exec = q, except = null } = {}) {
  if (st?.break_mode !== "fixed" || st.break_paid || !st.break_start || !st.break_end) return;
  const since = st.break_policy_since == null ? null : Number(st.break_policy_since);
  const start = Number(session.started_at);
  const until = session.ended_at == null ? t : Math.min(Number(session.ended_at), t);
  const exStart = except ? Number(except.started_at) : null;
  const exEnd = except ? (except.ended_at == null ? t : Number(except.ended_at)) : null;
  for (const [ws, we] of fixedWindows(st.timezone, start, until, st.break_start, st.break_end)) {
    if (ws > t || we <= start || ws >= until) continue;
    if (since !== null && ws < since) continue; // began before this policy was saved
    if (except && ws < exEnd && we > exStart) continue; // already coverable under the old bounds
    const [dayStart, dayEnd] = localDayBounds(st.timezone, ws);
    const day = { sid: session.id, dayStart, dayEnd };
    // Non-locking check first: once the day's row exists (the steady state on every
    // request) the locking INSERT below is skipped entirely.
    if ((await exec(`${FIXED_ON_DAY} LIMIT 1`, day)).length) continue;
    const insert = () => exec(
      `INSERT IGNORE INTO breaks (id, session_id, location_id, kind, started_at, ended_at)
       SELECT :id, :sid, :loc, 'fixed', :ws, :we FROM DUAL
        WHERE NOT EXISTS (${FIXED_ON_DAY})`,
      { ...day, id: randomUUID(), loc: session.location_id, ws, we }
    );
    try {
      await insert();
    } catch (e) {
      // Two autocommit recorders racing on the same still-empty day can deadlock on the
      // NOT EXISTS gap locks; InnoDB rolls one back, and its retry then sees the winner's
      // row and inserts nothing. Inside a transaction the caller's rollback handles it.
      if (e.code !== "ER_LOCK_DEADLOCK" || exec !== q) throw e;
      await insert();
    }
  }
}

/** Record started fixed windows for every open session (optionally one location). */
async function recordOpenFixedBreaks(loc = null) {
  const t = now();
  const open = await q(
    `SELECT s.id, s.location_id, s.started_at, s.ended_at,
            st.timezone, st.break_mode, st.break_start, st.break_end, st.break_paid,
            st.break_policy_since
       FROM sessions s
       JOIN settings st ON st.location_id = s.location_id
      WHERE s.ended_at IS NULL AND st.break_mode = 'fixed' AND st.break_paid = 0
        AND (:loc IS NULL OR s.location_id = :loc)`,
    { loc }
  );
  for (const s of open) await recordFixedBreaks(s, s, t);
}

/**
 * Caps forgotten sessions at max_session_hours and flags them 'auto'.
 * Runs on a timer AND lazily before reads, so correctness never depends
 * on the process staying alive between requests.
 */
async function autoCloseStale(loc = null) {
  // Before any session is capped, so windows inside it are recorded first.
  await recordOpenFixedBreaks(loc);
  await q(
    `UPDATE sessions s
       JOIN settings st ON st.location_id = s.location_id
        SET s.ended_at     = s.started_at + CAST(st.max_session_hours * 3600 AS SIGNED),
            s.duration_sec = CAST(st.max_session_hours * 3600 AS SIGNED),
            s.closed_by    = 'auto'
      WHERE s.ended_at IS NULL
        AND :now - s.started_at > st.max_session_hours * 3600
        AND (:loc IS NULL OR s.location_id = :loc)`,
    { now: now(), loc }
  );
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
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = new Hono();

if (env.ALLOWED_ORIGIN) {
  app.use("*", cors({
    origin: env.ALLOWED_ORIGIN,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }));
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code }, err.status);
  console.error(err);
  return c.json({ error: "INTERNAL_ERROR" }, 500);
});

app.get("/health", async (c) => {
  await q("SELECT 1");
  return c.json({ ok: true, time: now() });
});

/** Upsert the employee, ensure a settings row, and mint our HMAC token. */
async function issueSession({ userId, loc, role, name, email }) {
  const t = now();
  await q(
    `INSERT INTO employees (user_id, location_id, name, email, role, created_at, updated_at)
     VALUES (:uid, :loc, :name, :email, :role, :t, :t)
     ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email),
                             role = VALUES(role), updated_at = VALUES(updated_at)`,
    { uid: userId, loc, name: name ?? null, email: email ?? null, role, t }
  );
  await q("INSERT IGNORE INTO settings (location_id, updated_at) VALUES (:loc, :t)", { loc, t });
  const claims = { uid: userId, loc, role, name: name ?? "", email: email ?? "", exp: t + SESSION_TTL };
  const { exp, ...user } = claims;
  return { token: signToken(claims), user };
}

/* ---------- Auth ---------- */

app.post("/auth/sso", async (c) => {
  const { encryptedData } = (await c.req.json().catch(() => null)) ?? {};
  if (!encryptedData) throw new HttpError(400, "MISSING_ENCRYPTED_DATA");

  const d = decryptSSO(encryptedData, env.GHL_SHARED_SECRET);
  const loc = d.activeLocation;
  if (!loc) throw new HttpError(403, "OPEN_FROM_SUB_ACCOUNT");

  const role = d.role === "admin" || d.type === "agency" ? "manager" : "employee";
  return c.json(await issueSession({
    userId: d.userId, loc, role, name: d.userName ?? "", email: d.email ?? "",
  }));
});

// dev-login is available outside production, OR when PREVIEW_MODE=1 is set as a
// TEMPORARY demo flag on a production host. PREVIEW_MODE must be removed before
// real clients use the app — while it is on, anyone with the URL can sign in.
app.post("/auth/dev-login", async (c) => {
  if (env.NODE_ENV === "production" && env.PREVIEW_MODE !== "1") throw new HttpError(404, "DEV_LOGIN_DISABLED");
  const { role } = (await c.req.json().catch(() => null)) ?? {};
  const isMgr = role === "manager";
  return c.json(await issueSession({
    userId: isMgr ? "dev-manager" : "dev-employee",
    loc: "dev-local",
    role: isMgr ? "manager" : "employee",
    name: isMgr ? "مدير تجريبي" : "موظف تجريبي",
    email: "dev@local",
  }));
});

/* ---------- Employee ---------- */

app.get("/me/status", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const t = now();
  const st = await getSettings(loc);
  // "Today" is the location's calendar day, not the last 24 hours: an evening shift must
  // not show up in the next morning's total.
  const [dayStart, dayEnd] = localDayBounds(st?.timezone ?? "Asia/Riyadh", t);
  const from = intParam(c, "since", dayStart);

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
  let fixedBreak = todayFixedBreak(st, t);
  if (open.length && st) {
    // The window actually deducted today is the one recorded first (one per day), which
    // differs from today's policy window when the manager moved it after it was recorded.
    const [rec] = await q(
      `SELECT started_at, ended_at FROM breaks
        WHERE session_id = :sid AND kind = 'fixed' AND started_at >= :dayStart AND started_at < :dayEnd
        ORDER BY started_at LIMIT 1`,
      { sid: open[0].id, dayStart, dayEnd }
    );
    if (rec) fixedBreak = { starts_at: Number(rec.started_at), ends_at: Number(rec.ended_at), paid: false };
  }
  return c.json({
    open_session: open[0]
      ? { id: open[0].id, started_at: Number(open[0].started_at), break_sec: Number(open[0].break_sec) }
      : null,
    open_break: brk[0] ? { id: brk[0].id, started_at: Number(brk[0].started_at) } : null,
    worked_sec: Number(total[0].worked_sec),
    fixed_break: fixedBreak,
    // Lets the screen refresh at local midnight, when "today" starts over.
    day_ends_at: dayEnd,
    server_time: t,
  });
});

app.get("/me/settings", authed, async (c) => {
  const st = await getSettings(c.get("claims").loc);
  return c.json({
    daily_target_hours: Number(st?.daily_target_hours ?? 8),
    timezone: st?.timezone ?? "Asia/Riyadh",
    work_start: st?.work_start ?? null,
    breaks_enabled: Boolean(st?.breaks_enabled),
    note_on_stop: st?.note_on_stop ?? "off",
    break_mode: st?.break_mode ?? "off",
    break_start: st?.break_start ?? null,
    break_end: st?.break_end ?? null,
    break_paid: Boolean(st?.break_paid),
  });
});

app.get("/me/sessions", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const days = intParam(c, "days", 7);
  if (days < 1 || days > 31) throw new HttpError(400, "INVALID_DAYS");
  const from = now() - days * 86400;
  const sessions = (await q(
    `SELECT s.id, s.started_at, s.ended_at, s.duration_sec, s.closed_by, ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
      WHERE s.user_id = :uid AND s.location_id = :loc AND s.started_at >= :from
      ORDER BY s.started_at DESC
      LIMIT 100`,
    { uid, loc, from, now: now() }
  )).map((r) => ({ ...r, break_sec: Number(r.break_sec) }));
  const st = await getSettings(loc);
  return c.json({ sessions, timezone: st?.timezone ?? "Asia/Riyadh" });
});

app.post("/session/start", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const id = randomUUID();
  const t = now();
  try {
    await q(
      "INSERT INTO sessions (id, user_id, location_id, started_at, created_at) VALUES (:id, :uid, :loc, :t, :t)",
      { id, uid, loc, t }
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "SESSION_ALREADY_OPEN");
    throw e;
  }
  return c.json({ id, started_at: t }, 201);
});

app.post("/session/break/start", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  // Only flexible mode has an employee-driven break; fixed windows are automatic.
  if ((await getSettings(loc))?.break_mode !== "flexible") throw new HttpError(403, "BREAKS_DISABLED");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the open session so a concurrent /session/stop cannot close it between this
    // read and the break insert, which would otherwise open a break on a closed session.
    const [rows] = await conn.execute(
      "SELECT id FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL FOR UPDATE",
      { uid, loc }
    );
    if (!rows.length) throw new HttpError(409, "NO_OPEN_SESSION");
    const s = rows[0];
    const id = randomUUID();
    const t = now();
    try {
      await conn.execute(
        "INSERT INTO breaks (id, session_id, location_id, started_at) VALUES (:id, :sid, :loc, :t)",
        { id, sid: s.id, loc, t }
      );
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") throw new HttpError(409, "BREAK_ALREADY_OPEN");
      throw e;
    }
    await conn.commit();
    return c.json({ id, session_id: s.id, started_at: t }, 201);
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
});

app.post("/session/break/stop", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  // Ending a break is allowed even if the manager disabled breaks meanwhile —
  // otherwise the employee would be stuck on a break that can never end.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the open session first, in the same order as /session/stop, so the two
    // routes can never deadlock by locking sessions and breaks in opposite orders.
    const [sessionRows] = await conn.execute(
      "SELECT id FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL FOR UPDATE",
      { uid, loc }
    );
    if (!sessionRows.length) throw new HttpError(409, "NO_OPEN_BREAK");
    const sessionId = sessionRows[0].id;
    // Lock the open break on that session so a double-tap or a race with /session/stop
    // cannot both find it open and both report success.
    const [rows] = await conn.execute(
      "SELECT id, started_at FROM breaks WHERE session_id = :sid AND ended_at IS NULL FOR UPDATE",
      { sid: sessionId }
    );
    if (!rows.length) throw new HttpError(409, "NO_OPEN_BREAK");
    const b = rows[0];
    const t = now();
    const started = Number(b.started_at);
    await conn.execute("UPDATE breaks SET ended_at = :t WHERE id = :id AND ended_at IS NULL", { t, id: b.id });
    await conn.commit();
    return c.json({ id: b.id, started_at: started, ended_at: t, duration_sec: t - started });
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
});

const NOTE_MAX = 500;

app.post("/session/stop", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const body = (await c.req.json().catch(() => null)) ?? {};
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
    // Clipped to the session: a fixed window can run past the stop.
    const [[brk]] = await conn.execute(
      `SELECT COALESCE(SUM(GREATEST(0, LEAST(ended_at, :t) - GREATEST(started_at, :st))), 0) AS break_sec
         FROM breaks WHERE session_id = :id`,
      { id: s.id, t, st: s.started_at }
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

/* ---------- Manager ---------- */

app.get("/admin/live", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  await autoCloseStale(loc);
  const employees = await q(
    `SELECT e.user_id, e.name, e.email, s.id AS session_id, s.started_at, b.started_at AS break_started_at
       FROM employees e
       LEFT JOIN sessions s ON s.user_id = e.user_id AND s.location_id = e.location_id AND s.ended_at IS NULL
       LEFT JOIN breaks b ON b.session_id = s.id AND b.ended_at IS NULL
      WHERE e.location_id = :loc AND e.is_active = 1
      ORDER BY s.started_at IS NULL, e.name`,
    { loc }
  );
  const t = now();
  return c.json({ server_time: t, fixed_break: todayFixedBreak(await getSettings(loc), t), employees });
});

// Every local day overlapping [from, to) starts at most ~14h before `from` and ends at
// most ~14h after `to`, so a two-day pad keeps whole days while letting the
// (location_id, started_at) index narrow the scan before the per-row local-date math.
const SCAN_PAD = 2 * 86400;

/** Named params bounding a query to the local days covered by [from, to). */
function dayWindow(zone, from, to) {
  return {
    scanFrom: from - SCAN_PAD, scanTo: to + SCAN_PAD,
    fromDay: zone.dayStr(from), toDay: zone.dayStr(to - 1),
  };
}

app.get("/admin/report", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const from = intParam(c, "from");
  const to = intParam(c, "to");
  if (to <= from) throw new HttpError(400, "INVALID_RANGE");
  await autoCloseStale(loc);

  const st = await getSettings(loc);
  const tz = st?.timezone ?? "Asia/Riyadh";

  // Lateness threshold as seconds-since-local-midnight; NULL work_start disables it.
  const ws = st?.work_start ?? null;
  const graceSec = Number(st?.late_grace_minutes ?? 15) * 60;
  const lateAfterSec = ws
    ? Number(ws.slice(0, 2)) * 3600 + Number(ws.slice(3, 5)) * 60 + graceSec
    : null;
  // Each instant is mapped with the offset in force on its own date, so a window that
  // spans a DST change does not shift the sessions on the far side of it by an hour.
  const zone = localZone(tz, from - SCAN_PAD, Math.min(to, now()) + SCAN_PAD);
  const localDate = zone.sqlLocalDate;

  // late_days: the spec defines lateness by the employee's FIRST session of the local
  // DAY, and counts it "only on days with attendance" (spec §5.1). Two separate scopes:
  //   - MIN(started_at) is NOT restricted to [:from, :to), so a day's true first session
  //     is always seen even when the UI's rolling (non-midnight-aligned) window starts
  //     after it;
  //   - the candidate DAYS are restricted by EXISTS to local days on which the employee
  //     has at least one session overlapping [:from, :to) — the same overlap predicate
  //     days_present uses below. Without it a day whose only session ends before :from
  //     still produced a late day, so late_days could exceed days_present.
  const lateDaysByUser = new Map();
  if (lateAfterSec !== null) {
    const firstPerDay = await q(
      `SELECT s.user_id, MIN(s.started_at) AS first_started_at
         FROM sessions s
        WHERE s.location_id = :loc
          AND s.started_at >= :scanFrom AND s.started_at < :scanTo
          AND ${localDate("s.started_at")} BETWEEN :fromDay AND :toDay
          AND EXISTS (
                SELECT 1
                  FROM sessions p
                 WHERE p.location_id = s.location_id
                   AND p.user_id = s.user_id
                   AND p.started_at >= :scanFrom AND p.started_at < :scanTo
                   AND ${localDate("p.started_at")} = ${localDate("s.started_at")}
                   AND p.started_at < :to AND (p.ended_at IS NULL OR p.ended_at > :from)
              )
        GROUP BY s.user_id, ${localDate("s.started_at")}`,
      { loc, from, to, ...dayWindow(zone, from, to) }
    );
    for (const r of firstPerDay) {
      if (zone.localTod(r.first_started_at) > lateAfterSec) {
        lateDaysByUser.set(r.user_id, (lateDaysByUser.get(r.user_id) ?? 0) + 1);
      }
    }
  }

  const employees = await q(
    `SELECT e.user_id, e.name, e.email,
            COALESCE(SUM(${WORKED_EXPR}), 0)                                 AS worked_sec,
            COUNT(s.id)                                                      AS sessions_count,
            COUNT(DISTINCT ${localDate("s.started_at")})                      AS days_present,
            COALESCE(SUM(CASE WHEN s.closed_by = 'auto' THEN 1 ELSE 0 END), 0) AS auto_closed
       FROM employees e
       LEFT JOIN sessions s
              ON s.user_id = e.user_id AND s.location_id = e.location_id
             AND s.started_at < :to AND (s.ended_at IS NULL OR s.ended_at > :from)
      WHERE e.location_id = :loc AND e.is_active = 1
      GROUP BY e.user_id, e.name, e.email
      ORDER BY worked_sec DESC`,
    { now: now(), to, from, loc }
  );

  return c.json({
    from, to, timezone: tz,
    daily_target_hours: st?.daily_target_hours ?? 8,
    work_start: ws,
    employees: employees.map((r) => ({
      ...r,
      worked_sec: Number(r.worked_sec),
      late_days: lateDaysByUser.get(r.user_id) ?? 0,
    })),
  });
});

app.get("/admin/sessions", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const from = intParam(c, "from");
  const to = intParam(c, "to");
  const uid = c.req.query("user_id") ?? null;
  await autoCloseStale(loc);
  const sessions = (await q(
    `SELECT s.id, s.user_id, e.name, s.started_at, s.ended_at, s.duration_sec, s.closed_by, s.note,
            ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
       JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = :loc AND s.started_at >= :from AND s.started_at < :to
        AND (:uid IS NULL OR s.user_id = :uid)
      ORDER BY s.started_at DESC
      LIMIT 1000`,
    { loc, from, to, uid, now: now() }
  )).map((r) => ({ ...r, break_sec: Number(r.break_sec) }));

  // Annotate each session with how late it was, so the manager can audit the
  // late_days count in /admin/report instead of just seeing a total.
  // Lateness belongs to the DAY's first session (spec §5.1), so MIN(started_at) is
  // resolved over whole local days — never restricted to [:from, :to) — otherwise a
  // day whose real first session precedes a rolling window would mark the wrong
  // session as late.
  const st = await getSettings(loc);
  const tz = st?.timezone ?? "Asia/Riyadh";
  const ws = st?.work_start ?? null;
  const lateAfterSec = ws
    ? Number(ws.slice(0, 2)) * 3600 + Number(ws.slice(3, 5)) * 60 + Number(st?.late_grace_minutes ?? 15) * 60
    : null;
  const zone = localZone(tz, from - SCAN_PAD, Math.min(to, now()) + SCAN_PAD);
  const localDate = zone.sqlLocalDate;

  let firstByUserDay = new Map();
  if (lateAfterSec !== null && sessions.length) {
    const rows = await q(
      `SELECT s.user_id, MIN(s.started_at) AS first_started_at
         FROM sessions s
        WHERE s.location_id = :loc
          AND s.started_at >= :scanFrom AND s.started_at < :scanTo
          AND ${localDate("s.started_at")} BETWEEN :fromDay AND :toDay
          AND (:uid IS NULL OR s.user_id = :uid)
        GROUP BY s.user_id, ${localDate("s.started_at")}`,
      { loc, uid, ...dayWindow(zone, from, to) }
    );
    firstByUserDay = new Map(
      rows.map((r) => [`${r.user_id}|${zone.localDayKey(r.first_started_at)}`, Number(r.first_started_at)])
    );
  }

  const annotated = sessions.map((s) => {
    if (lateAfterSec === null) return { ...s, late_by_sec: null };
    const first = firstByUserDay.get(`${s.user_id}|${zone.localDayKey(s.started_at)}`);
    const isDayFirst = first !== undefined && first === Number(s.started_at);
    const over = zone.localTod(s.started_at) - lateAfterSec;
    return { ...s, late_by_sec: isDayFirst && over > 0 ? over : null };
  });

  return c.json({ sessions: annotated, timezone: tz, work_start: ws });
});

app.patch("/admin/sessions/:id", authed, managerOnly, async (c) => {
  const { loc, uid: editor } = c.get("claims");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) ?? {};
  const reason = String(body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "REASON_REQUIRED");
  const s = body.started_at, e = body.ended_at;
  if (!Number.isInteger(s) || !Number.isInteger(e) || e <= s || e > now()) throw new HttpError(400, "INVALID_TIMES");
  // An open session may be inside a window that has begun but isn't recorded yet; record
  // it now, because the edit below skips every window the old bounds already covered.
  await recordOpenFixedBreaks(loc);
  const st = await getSettings(loc);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT * FROM sessions WHERE id = :id AND location_id = :loc FOR UPDATE", { id, loc }
    );
    if (!rows.length) throw new HttpError(404, "SESSION_NOT_FOUND");
    const old = rows[0];
    await conn.execute(
      `UPDATE sessions SET started_at = :s, ended_at = :e, duration_sec = :dur, closed_by = 'admin'
        WHERE id = :id AND location_id = :loc`,
      { s, e, dur: e - s, id, loc }
    );
    await conn.execute(
      `INSERT INTO edits_log (id, session_id, location_id, editor_user_id, old_started_at, old_ended_at,
                              new_started_at, new_ended_at, reason, created_at)
       VALUES (:lid, :id, :loc, :editor, :os, :oe, :s, :e, :reason, :t)`,
      { lid: randomUUID(), id, loc, editor, os: old.started_at, oe: old.ended_at, s, e, reason: reason.slice(0, 500), t: now() }
    );
    // The new bounds may now cover a fixed window the old bounds didn't; record only
    // that, atomically with the edit — never a window already coverable before the edit.
    await recordFixedBreaks(
      { id, location_id: loc, started_at: s, ended_at: e }, st, now(),
      {
        exec: async (sql, p) => (await conn.execute(sql, p))[0],
        except: { started_at: old.started_at, ended_at: old.ended_at },
      }
    );
    await conn.commit();
    return c.json({ id, started_at: s, ended_at: e, duration_sec: e - s, closed_by: "admin" });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
});

app.get("/admin/export.csv", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const from = intParam(c, "from");
  const to = intParam(c, "to");
  await autoCloseStale(loc);
  const tz = (await getSettings(loc))?.timezone ?? "Asia/Riyadh";
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
  // Same rounding rule as the UI's formatBreak: 0 with no break, otherwise at least 1
  // minute, so a short break (e.g. 20s) doesn't silently round down to 0 here while the
  // UI shows "1 د".
  const breakMin = (sec) => {
    const s = Number(sec);
    return s > 0 ? Math.max(1, Math.round(s / 60)) : 0;
  };
  const lines = [
    ["Employee", "Email", "Start", "End", "Hours", "Break (min)", "Closed by", "Note"],
    ...rows.map((r) => [r.name, r.email, fmt(r.started_at), fmt(r.ended_at),
      r.duration_sec ? (Math.max(0, Number(r.duration_sec) - Number(r.break_sec)) / 3600).toFixed(2) : "",
      breakMin(r.break_sec), r.closed_by ?? "open", r.note ?? ""]),
  ];
  const csv = "\uFEFF" + lines.map((l) => l.map(esc).join(",")).join("\r\n"); // BOM → Excel reads Arabic
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="timeclock-${from}-${to}.csv"`,
  });
});

app.get("/admin/settings", authed, managerOnly, async (c) => {
  return c.json(await getSettings(c.get("claims").loc));
});

// The read scope our Marketplace app requests for activity (spec §3).
const ACTIVITY_SCOPE = "conversations/message.readonly";

app.get("/admin/ghl-connection", authed, managerOnly, async (c) => {
  await purgeOldActivity();
  const { loc } = c.get("claims");
  const [row] = await q(
    "SELECT scopes, installed_at, uninstalled_at, last_event_at FROM ghl_installs WHERE location_id = :loc",
    { loc }
  );
  const [cnt] = await q(
    "SELECT COUNT(*) AS n FROM activity_events WHERE location_id = :loc AND occurred_at >= :since",
    { loc, since: now() - 86400 }
  );
  const scopes = String(row?.scopes ?? "").split(/[\s,]+/).filter(Boolean);
  return c.json({
    installed: Boolean(row?.installed_at && !row?.uninstalled_at),
    has_activity_scope: scopes.includes(ACTIVITY_SCOPE),
    last_event_at: row?.last_event_at == null ? null : Number(row.last_event_at),
    events_24h: Number(cnt.n),
  });
});

app.put("/admin/settings", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  // Windows that already began under the CURRENT policy are recorded before it changes;
  // otherwise saving a new policy would silently drop them.
  await recordOpenFixedBreaks(loc);
  const b = (await c.req.json().catch(() => null)) ?? {};
  try { new Intl.DateTimeFormat("en", { timeZone: b.timezone }); } catch { throw new HttpError(400, "INVALID_TIMEZONE"); }
  if (!b.timezone) throw new HttpError(400, "INVALID_TIMEZONE");
  const target = Number(b.daily_target_hours), max = Number(b.max_session_hours);
  if (!(target > 0 && target <= 24) || !(max >= 1 && max <= 24)) throw new HttpError(400, "INVALID_HOURS");
  if (b.work_start && !HHMM.test(b.work_start)) throw new HttpError(400, "INVALID_WORK_START");
  // Absent / null / empty-string grace falls back to the 15-minute default: an emptied
  // UI field arrives as "" and Number("") === 0, which would silently make the policy
  // "late one second after work_start". An explicit numeric 0 still means "no grace".
  const rawGrace = b.late_grace_minutes;
  const grace = rawGrace === undefined || rawGrace === null || rawGrace === "" ? 15 : Number(rawGrace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new HttpError(400, "INVALID_GRACE");
  // PUT replaces the whole policy: an omitted field means the default, not "unchanged".
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
  if (b.activity_monitoring !== undefined && typeof b.activity_monitoring !== "boolean") {
    throw new HttpError(400, "INVALID_ACTIVITY_MONITORING");
  }
  const monitoring = b.activity_monitoring === true;
  // Same empty-field rule as the grace: "" / null / absent mean the 30-minute default.
  const rawIdle = b.idle_minutes;
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
                         late_grace_minutes = :grace, max_session_hours = :max,
                         breaks_enabled = :breaksEnabled, break_mode = :breakMode,
                         break_start = :breakStart, break_end = :breakEnd, break_paid = :breakPaid,
                         activity_monitoring = :monitoring, idle_minutes = :idleMinutes,
                         note_on_stop = :notePolicy, updated_at = :t
      WHERE location_id = :loc`,
    {
      tz: b.timezone, target, ws: b.work_start ?? null, grace, max,
      // Kept in sync so code that still reads breaks_enabled behaves the same.
      breaksEnabled: breakMode === "flexible" ? 1 : 0, breakMode, breakStart, breakEnd,
      breakPaid: breakPaid ? 1 : 0, notePolicy, t: now(), loc,
      monitoring: monitoring ? 1 : 0, idleMinutes,
    }
  );
  return c.json(await getSettings(loc));
});

/* ---------- GHL (called by GHL, not by a signed-in user) ---------- */

const ACTIVITY_RETENTION_SEC = 90 * 86400;
const WEBHOOK_MAX_BYTES = 256 * 1024;

/** Raw activity rows are metadata kept for 90 days; summaries and alerts stay (spec §4). */
async function purgeOldActivity() {
  await q("DELETE FROM activity_events WHERE occurred_at < :cutoff", { cutoff: now() - ACTIVITY_RETENTION_SEC });
}

// The cap is enforced before the body is buffered (Content-Length up front, or by stopping
// a chunked read at the limit), so an oversized unsigned POST cannot exhaust memory.
const WEBHOOK_DRAIN_MAX_BYTES = 8 * 1024 * 1024;
const webhookBodyLimit = bodyLimit({
  maxSize: WEBHOOK_MAX_BYTES,
  onError: async (c) => {
    // Discard (never buffer) up to a few MB of the unread upload before answering. Replying
    // while the client is still sending makes the socket reset, so the client would see
    // ECONNRESET instead of the 413. Past the drain cap we stop reading and let it close.
    try {
      const reader = c.req.raw.body?.getReader();
      let drained = 0;
      while (reader && drained < WEBHOOK_DRAIN_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        drained += value.length;
      }
    } catch { /* client went away; answer anyway */ }
    throw new HttpError(413, "PAYLOAD_TOO_LARGE");
  },
});

// One log line per minute at most, so a flood of bad signatures cannot flood the log.
let lastBadSignatureLogAt = 0;

app.post("/ghl/webhook", webhookBodyLimit, async (c) => {
  const raw = await c.req.text();
  // The signature is the only authentication this route has. The test key is honoured only
  // when NODE_ENV is explicitly "development" or "test" (fails closed otherwise).
  const allowTestKey = testKeyAllowed(env.NODE_ENV);
  const signature = c.req.header("x-ghl-signature");
  if (!verifyGhlSignature(raw, signature, { allowTestKey })) {
    const nowMs = Date.now();
    if (nowMs - lastBadSignatureLogAt >= 60_000) {
      lastBadSignatureLogAt = nowMs;
      console.warn("[webhook] bad signature", { bytes: Buffer.byteLength(raw, "utf8"), hasHeader: Boolean(signature) });
    }
    throw new HttpError(401, "WEBHOOK_BAD_SIGNATURE");
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return c.json({ ok: true }); }
  const t = now();
  const ev = parseWebhook(payload, t);
  // Always acknowledge a signed event, stored or not, so GHL does not retry it.
  if (!ev.locationId) return c.json({ ok: true });

  if (ev.event === "install" || ev.event === "uninstall") {
    // GHL signs all apps' events with one key: ignore (but acknowledge) another app's.
    if (!isForOurApp(ev, env.GHL_APP_ID)) return c.json({ ok: true });
    const installed = ev.event === "install";
    await q(
      `INSERT INTO ghl_installs (location_id, company_id, installed_at, uninstalled_at, last_event_at, updated_at)
       VALUES (:loc, :company, :installedAt, :uninstalledAt, :t, :t)
       ON DUPLICATE KEY UPDATE company_id = COALESCE(VALUES(company_id), company_id),
                               installed_at = COALESCE(VALUES(installed_at), installed_at),
                               uninstalled_at = VALUES(uninstalled_at),
                               last_event_at = VALUES(last_event_at), updated_at = VALUES(updated_at)`,
      { loc: ev.locationId, company: ev.companyId, installedAt: installed ? t : null, uninstalledAt: installed ? null : t, t }
    );
    return c.json({ ok: true });
  }

  // Any other signed event for this location proves events are arriving.
  await q(
    `INSERT INTO ghl_installs (location_id, last_event_at, updated_at) VALUES (:loc, :t, :t)
     ON DUPLICATE KEY UPDATE last_event_at = VALUES(last_event_at), updated_at = VALUES(updated_at)`,
    { loc: ev.locationId, t }
  );

  if (ev.event === "activity") {
    const [st] = await q("SELECT activity_monitoring FROM settings WHERE location_id = :loc", { loc: ev.locationId });
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
    }
  }
  return c.json({ ok: true });
});

const DEFAULT_REDIRECT_URI = "https://timeclock.noursky.com/ghl/oauth/callback";

// A tiny self-contained Arabic page; the texts are fixed strings, never request data.
function installPage(title, message) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#F7F6FB;color:#1D1B2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:460px;background:#fff;border:1px solid #E3E0F0;border-radius:14px;padding:28px}h1{color:#6C5CE7;font-size:20px;margin:0 0 10px}p{margin:0;line-height:1.8}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

app.get("/ghl/oauth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.html(installPage("تعذّر التثبيت", "الرابط ناقص. أعد تثبيت التطبيق من الـ Marketplace."), 400);
  }
  // A malformed key is "not configured": check before the single-use code is spent.
  if (!env.GHL_CLIENT_ID || !env.GHL_CLIENT_SECRET || !/^[0-9a-f]{64}$/i.test(env.TOKEN_ENC_KEY || "")) {
    return c.html(installPage("تعذّر التثبيت", "الربط مع GHL غير مُعدّ على السيرفر بعد. تواصل مع NourSky."), 503);
  }
  let tok;
  try {
    tok = await exchangeCode({
      code, clientId: env.GHL_CLIENT_ID, clientSecret: env.GHL_CLIENT_SECRET,
      redirectUri: env.GHL_REDIRECT_URI || DEFAULT_REDIRECT_URI,
    });
  } catch (e) {
    console.error("[oauth]", e.message, e.status ?? "");
    if (e.message === "OAUTH_UNREACHABLE") {
      return c.html(installPage("تعذّر التثبيت", "ما قدرنا نوصل لـ GHL. جرّب تعيد التثبيت بعد شوي."), 504);
    }
    return c.html(installPage("تعذّر التثبيت", "GHL رفض طلب الربط. أعد تثبيت التطبيق من الـ Marketplace."), 502);
  }
  try {
    const t = now();
    await q(
      `INSERT INTO ghl_installs (location_id, company_id, access_token_enc, refresh_token_enc, token_expires_at,
                                 scopes, installed_at, uninstalled_at, updated_at)
       VALUES (:loc, :company, :access, :refresh, :expiresAt, :scopes, :t, NULL, :t)
       ON DUPLICATE KEY UPDATE company_id = VALUES(company_id), access_token_enc = VALUES(access_token_enc),
                               refresh_token_enc = VALUES(refresh_token_enc), token_expires_at = VALUES(token_expires_at),
                               scopes = VALUES(scopes), installed_at = VALUES(installed_at),
                               uninstalled_at = NULL, updated_at = VALUES(updated_at)`,
      {
        loc: tok.locationId, company: tok.companyId,
        access: encryptToken(tok.accessToken, env.TOKEN_ENC_KEY),
        refresh: tok.refreshToken ? encryptToken(tok.refreshToken, env.TOKEN_ENC_KEY) : null,
        expiresAt: t + tok.expiresIn, scopes: String(tok.scopes).slice(0, 1000), t,
      }
    );
  } catch (e) {
    console.error("[oauth] store failed", e.message);
    return c.html(installPage("تعذّر التثبيت", "صار خطأ أثناء حفظ الربط. أعد تثبيت التطبيق من الـ Marketplace."), 500);
  }
  return c.html(installPage("تم الربط", "تم ربط TimeClock بحسابك. بتقدر تسكّر هالصفحة وترجع لـ GHL."));
});

/* ---------- Static SPA (must be registered AFTER all API routes) ---------- */
app.use("/*", serveStatic({ root: "./public" }));
app.get("/*", serveStatic({ path: "./public/index.html" })); // SPA fallback

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

setInterval(() => autoCloseStale().catch((e) => console.error("[auto-close]", e)), AUTO_CLOSE_EVERY_MS);
setInterval(() => purgeOldActivity().catch((e) => console.error("[activity-retention]", e)), AUTO_CLOSE_EVERY_MS);

const port = Number(env.PORT || 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[timeclock] listening on :${port}`));

export default app;
