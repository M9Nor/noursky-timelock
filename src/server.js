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
import { isWithinWorkHours, isFreshEvent, idleSeconds, sessionSummary, idleAlertAt, isLateActivity } from "./activity.js";
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
// Trimmed: a stray space pasted into hPanel would otherwise reject every install event.
const GHL_APP_ID = (env.GHL_APP_ID ?? "").trim() || null;
const numOrNull = (v) => (v == null ? null : Number(v));

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
  await closeIdleOnEndedSessions(loc).catch((e) => console.error("[idle-close]", e));
  await summarizeClosedSessions(loc).catch((e) => console.error("[activity-summary]", e));
}

/** Break intervals of one session as [start, end|null], plus its fixed windows (paid ones too). */
async function sessionBreaks(session, st, until) {
  const rows = await q("SELECT started_at, ended_at FROM breaks WHERE session_id = :sid", { sid: session.id });
  const out = rows.map((b) => [Number(b.started_at), b.ended_at == null ? null : Number(b.ended_at)]);
  if (st?.break_mode === "fixed" && st.break_start && st.break_end) {
    out.push(...fixedWindows(st.timezone, Number(session.started_at), until, st.break_start, st.break_end));
  }
  return out;
}

/** This employee's counted events (with a user id) inside [from, to]. */
async function eventTimes(loc, uid, from, to) {
  const rows = await q(
    `SELECT occurred_at FROM activity_events
      WHERE location_id = :loc AND user_id = :uid AND occurred_at >= :from AND occurred_at <= :to`,
    { loc, uid, from, to }
  );
  return rows.map((r) => Number(r.occurred_at));
}

/** This employee's latest counted event inside [from, to], or null. */
async function lastEventAt(loc, uid, from, to) {
  const [row] = await q(
    `SELECT MAX(occurred_at) AS at FROM activity_events
      WHERE location_id = :loc AND user_id = :uid AND occurred_at >= :from AND occurred_at <= :to`,
    { loc, uid, from, to }
  );
  return row?.at == null ? null : Number(row.at);
}

/**
 * Computes and stores one closed session's activity summary (spec §5.6). Used for every
 * close path via summarizeClosedSessions, and directly after a manager edit, which must
 * refill the summary however old the session is (summaries are kept forever). A location
 * that never had monitoring has no activity_monitoring_since, and sessionSummary returns
 * null for a session monitoring did not cover. Outage guard: with no event at all at the
 * location in the 24 h before the session ended, the summary stays NULL ("—") instead of
 * being stored as "0 activity, long idle" — the location may not send events (not updated
 * to the 2.0.0 app, a GHL outage).
 */
async function summarizeSession(loc, st, session) {
  if (st?.activity_monitoring_since == null) return;
  const since = Number(st.activity_monitoring_since);
  const start = Number(session.started_at), end = Number(session.ended_at);
  const [fresh] = await q(
    `SELECT 1 AS ok FROM activity_events
      WHERE location_id = :loc AND occurred_at > :from AND occurred_at <= :end LIMIT 1`,
    { loc, from: end - 86400, end }
  );
  if (!fresh) return;
  const sum = sessionSummary({
    startedAt: start, endedAt: end, monitoringSince: since,
    eventTimes: await eventTimes(loc, session.user_id, start, end),
    breaks: await sessionBreaks(session, st, end),
  });
  if (!sum) return;
  // Only if the row still has the bounds read above: a concurrent manager edit nulls the
  // summary and changes them, and must not be overwritten with a summary of the old bounds.
  await q(
    `UPDATE sessions SET activity_count = :n, last_activity_at = :last, longest_idle_sec = :idle
      WHERE id = :id AND activity_count IS NULL AND started_at = :s AND ended_at = :e`,
    { n: sum.activity_count, last: sum.last_activity_at, idle: sum.longest_idle_sec, id: session.id, s: start, e: end }
  );
}

/**
 * Stores the activity summary (spec §5.6) of recently closed sessions that have none, for
 * locations with monitoring on. Every close path ends up here — /session/stop, auto-close,
 * and a manager edit (which clears the summary first) — so the rule lives in one place.
 * A session that closed while monitoring was off keeps NULL, shown as "—".
 */
async function summarizeClosedSessions(loc = null) {
  const locs = loc
    ? [loc]
    : (await q("SELECT location_id FROM settings WHERE activity_monitoring = 1")).map((r) => r.location_id);
  const t = now();
  for (const l of locs) {
    try {
      const st = await getSettings(l);
      if (!st?.activity_monitoring || st.activity_monitoring_since == null) continue;
      const since = Number(st.activity_monitoring_since);
      // Sessions are <= max_session_hours (<= 24 h) unless a manager edit stretched them, so
      // 9 days of start times covers every session that ended in the last 7.
      const rows = await q(
        `SELECT id, user_id, started_at, ended_at FROM sessions
          WHERE location_id = :loc AND started_at >= :scanFrom AND ended_at IS NOT NULL
            AND activity_count IS NULL AND ended_at > :since AND ended_at > :recent
          ORDER BY ended_at DESC
          LIMIT 50`,
        { loc: l, since, recent: t - 7 * 86400, scanFrom: t - 9 * 86400 }
      );
      for (const s of rows) await summarizeSession(l, st, s);
    } catch (e) {
      console.error("[activity-summary]", l, e);
    }
  }
}

/**
 * Per-employee activity for the live floor (spec §5.3): idle seconds of open sessions, and
 * who is working without a session. Idle is null when monitoring is off or when the
 * location's newest event is over 24 h old (outage guard — other apps' events also refresh
 * ghl_installs.last_event_at, so that column is not used here).
 */
async function liveActivity(loc, st, employees, t) {
  const blank = () => ({ last_activity_at: null, idle_sec: null, active_without_session: false });
  const out = new Map(employees.map((e) => [e.user_id, blank()]));
  if (!st?.activity_monitoring) return out;
  const nci = await q(
    `SELECT user_id FROM activity_alerts
      WHERE location_id = :loc AND kind = 'working_not_clocked_in' AND status = 'open'`,
    { loc }
  );
  for (const r of nci) if (out.has(r.user_id)) out.get(r.user_id).active_without_session = true;
  const [fresh] = await q(
    "SELECT 1 AS ok FROM activity_events WHERE location_id = :loc AND occurred_at > :cutoff LIMIT 1",
    { loc, cutoff: t - 86400 }
  );
  if (!fresh) return out;
  for (const e of employees) {
    if (!e.session_id) continue;
    const start = Number(e.started_at);
    const lastAt = await lastEventAt(loc, e.user_id, start, t);
    const row = out.get(e.user_id);
    row.last_activity_at = lastAt;
    row.idle_sec = idleSeconds({
      startedAt: start, monitoringSince: st.activity_monitoring_since, lastEventAt: lastAt, now: t,
      breaks: await sessionBreaks({ id: e.session_id, started_at: start }, st, t),
    });
  }
  return out;
}

/**
 * Phase C (spec §12.1): opens an idle alert for every open session at a monitored location
 * whose quiet stretch (breaks removed) reached idle_minutes. Runs on a 60 s timer and lazily
 * before the alert and live reads (the employee's own poll passes `uid` and scans only that
 * employee's session). ux_alert_idle_open keeps one ongoing alert per session; a stretch
 * already alerted (same session and from_at) is never alerted again, even after a dismiss.
 * Outage guard: no alert unless the location received an event in the last 24 h.
 */
async function detectIdle(loc = null, uid = null) {
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
        `SELECT id, user_id, started_at FROM sessions
          WHERE location_id = :loc AND ended_at IS NULL AND (:uid IS NULL OR user_id = :uid)`,
        { loc: l, uid }
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
        const ins = await q(
          `INSERT IGNORE INTO activity_alerts (id, location_id, user_id, session_id, kind, from_at, detected_at, status)
           VALUES (:id, :loc, :uid, :sid, 'idle', :fromAt, :t, 'open')`,
          { id: randomUUID(), loc: l, uid: s.user_id, sid: s.id, fromAt, t }
        );
        // Race with the webhook: an event stored after lastEventAt was read but before this row
        // existed found no stretch to end. Look again now that the alert is visible.
        if (ins.affectedRows > 0) {
          const [after] = await q(
            `SELECT MIN(occurred_at) AS at FROM activity_events
              WHERE location_id = :loc AND user_id = :uid AND occurred_at > :fromAt`,
            { loc: l, uid: s.user_id, fromAt }
          );
          if (after?.at != null) await endIdleStretch(st, l, s.user_id, Number(after.at), t);
        }
      }
    } catch (e) {
      console.error("[idle-detect]", l, e);
    }
  }
}

/**
 * Spec §12.2: a counted event ends this employee's idle stretch. The alert keeps status open
 * for the manager with to_at = the event time — or, when the stretch never really reached the
 * threshold (a delayed delivery), it is resolved as late activity. It also covers a stretch
 * that was already ended by a newer event or by the session end: an event dated inside it
 * (out-of-order delivery, a delivery after the stop) shortens it the same way. `<` on
 * from_at: an event in the same second as the start is the same moment, not activity after it.
 */
async function endIdleStretch(st, loc, uid, at, t) {
  const rows = await q(
    `SELECT a.id, a.from_at, a.session_id, s.started_at
       FROM activity_alerts a JOIN sessions s ON s.id = a.session_id
      WHERE a.location_id = :loc AND a.user_id = :uid AND a.kind = 'idle'
        AND a.status = 'open' AND a.from_at < :at AND (a.to_at IS NULL OR a.to_at > :at)`,
    { loc, uid, at }
  );
  for (const a of rows) {
    const breaks = await sessionBreaks({ id: a.session_id, started_at: a.started_at }, st, at);
    if (isLateActivity({ fromAt: a.from_at, occurredAt: at, breaks, idleMinutes: Number(st.idle_minutes) })) {
      await q(
        `UPDATE activity_alerts
            SET to_at = :at, status = 'resolved', resolution = 'late_activity', resolved_by = 'system', resolved_at = :t
          WHERE id = :id AND status = 'open' AND (to_at IS NULL OR to_at > :at)`,
        { at, t, id: a.id }
      );
    } else {
      await q(
        "UPDATE activity_alerts SET to_at = :at WHERE id = :id AND status = 'open' AND (to_at IS NULL OR to_at > :at)",
        { at, id: a.id }
      );
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
    activity_monitoring: Boolean(st?.activity_monitoring),
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

const ALERT_NOTE_MAX = 300;

app.get("/me/alerts", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await detectIdle(loc, uid).catch((e) => console.error("[idle-detect]", e));
  const alerts = (await q(
    `SELECT ${ALERT_COLUMNS} FROM activity_alerts a
      WHERE a.location_id = :loc AND a.user_id = :uid AND a.status = 'open'
        AND (a.kind <> 'idle' OR a.to_at IS NULL)
      ORDER BY a.from_at DESC`,
    { loc, uid }
  )).map(alertRow);
  const st = await getSettings(loc);
  return c.json({ alerts, timezone: st?.timezone ?? "Asia/Riyadh", server_time: now() });
});

app.post("/me/alerts/:id/note", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  const body = (await c.req.json().catch(() => null)) ?? {};
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) throw new HttpError(400, "NOTE_REQUIRED");
  if (note.length > ALERT_NOTE_MAX) throw new HttpError(400, "NOTE_TOO_LONG");
  const r = await q(
    `UPDATE activity_alerts SET employee_note = :note, employee_note_at = :t
      WHERE id = :id AND location_id = :loc AND user_id = :uid AND status = 'open'`,
    { note, t: now(), id: c.req.param("id"), loc, uid }
  );
  if (!r.affectedRows) throw new HttpError(404, "ALERT_NOT_FOUND");
  return c.json({ ok: true });
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
  // Clocking in answers any open "working, not clocked in" alert (spec §5.3).
  await q(
    `UPDATE activity_alerts
        SET status = 'resolved', resolution = 'clocked_in', resolved_by = 'system', resolved_at = :t
      WHERE location_id = :loc AND user_id = :uid AND kind = 'working_not_clocked_in' AND status = 'open'`,
    { loc, uid, t }
  );
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
    await closeIdleOnEndedSessions(loc).catch((e) => console.error("[idle-close]", e));
    await summarizeClosedSessions(loc).catch((e) => console.error("[activity-summary]", e));
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
  await detectIdle(loc).catch((e) => console.error("[idle-detect]", e));
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
  const st = await getSettings(loc);
  const activity = await liveActivity(loc, st, employees, t);
  return c.json({
    server_time: t,
    fixed_break: todayFixedBreak(st, t),
    idle_minutes: st?.activity_monitoring ? Number(st.idle_minutes) : null,
    employees: employees.map((e) => ({ ...e, ...activity.get(e.user_id) })),
  });
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
            s.activity_count, s.longest_idle_sec,
            ${BREAK_SEC_EXPR} AS break_sec
       FROM sessions s
       JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = :loc AND s.started_at >= :from AND s.started_at < :to
        AND (:uid IS NULL OR s.user_id = :uid)
      ORDER BY s.started_at DESC
      LIMIT 1000`,
    { loc, from, to, uid, now: now() }
  )).map((r) => ({
    ...r,
    break_sec: Number(r.break_sec),
    activity_count: numOrNull(r.activity_count),
    longest_idle_sec: numOrNull(r.longest_idle_sec),
  }));

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
      `UPDATE sessions SET started_at = :s, ended_at = :e, duration_sec = :dur, closed_by = 'admin',
                           activity_count = NULL, last_activity_at = NULL, longest_idle_sec = NULL
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
    await closeIdleOnEndedSessions(loc).catch((e) => console.error("[idle-close]", e));
    // The edit cleared the summary: refill it whatever the session's age (the periodic pass
    // only looks at recent ones), as long as monitoring was ever on here.
    await summarizeSession(loc, st, { id, user_id: old.user_id, started_at: s, ended_at: e })
      .catch((err) => console.error("[activity-summary]", err));
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
            s.activity_count, s.longest_idle_sec,
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
    ["Employee", "Email", "Start", "End", "Hours", "Break (min)", "Closed by", "Note", "Activity", "Longest idle (min)"],
    ...rows.map((r) => [r.name, r.email, fmt(r.started_at), fmt(r.ended_at),
      r.duration_sec ? (Math.max(0, Number(r.duration_sec) - Number(r.break_sec)) / 3600).toFixed(2) : "",
      breakMin(r.break_sec), r.closed_by ?? "open", r.note ?? "",
      r.activity_count ?? "", r.longest_idle_sec == null ? "" : Math.round(Number(r.longest_idle_sec) / 60)]),
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
  // Counted events (with a user id) from people who never opened TimeClock here (spec §5.4).
  const [unknown] = await q(
    `SELECT COUNT(DISTINCT a.user_id) AS n
       FROM activity_events a
       LEFT JOIN employees e ON e.user_id = a.user_id AND e.location_id = a.location_id
      WHERE a.location_id = :loc AND a.user_id IS NOT NULL AND a.occurred_at >= :since AND e.user_id IS NULL`,
    { loc, since: now() - 7 * 86400 }
  );
  const scopes = String(row?.scopes ?? "").split(/[\s,]+/).filter(Boolean);
  return c.json({
    installed: Boolean(row?.installed_at && !row?.uninstalled_at),
    has_activity_scope: scopes.includes(ACTIVITY_SCOPE),
    last_event_at: row?.last_event_at == null ? null : Number(row.last_event_at),
    events_24h: Number(cnt.n),
    unknown_active_users: Number(unknown.n),
  });
});

const ALERT_STATUSES = ["open", "resolved", "dismissed"];
const ALERT_COLUMNS = `a.id, a.user_id, a.session_id, a.kind, a.from_at, a.to_at, a.status, a.resolution,
  a.employee_note, a.employee_note_at, a.detected_at, a.resolved_at`;
/** BIGINT columns as plain numbers, so the UI never sees a string timestamp. */
function alertRow(r) {
  return {
    ...r,
    from_at: Number(r.from_at), to_at: numOrNull(r.to_at), detected_at: Number(r.detected_at),
    employee_note_at: numOrNull(r.employee_note_at), resolved_at: numOrNull(r.resolved_at),
  };
}

app.get("/admin/alerts", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  await detectIdle(loc).catch((e) => console.error("[idle-detect]", e));
  const status = c.req.query("status") ?? "open";
  if (!ALERT_STATUSES.includes(status)) throw new HttpError(400, "INVALID_STATUS");
  const alerts = (await q(
    `SELECT ${ALERT_COLUMNS}, e.name
       FROM activity_alerts a
       LEFT JOIN employees e ON e.user_id = a.user_id AND e.location_id = a.location_id
      WHERE a.location_id = :loc AND a.status = :status
      ORDER BY a.from_at DESC, a.id DESC
      LIMIT 200`,
    { loc, status }
  )).map(alertRow);
  const st = await getSettings(loc);
  return c.json({ alerts, timezone: st?.timezone ?? "Asia/Riyadh", server_time: now() });
});

app.post("/admin/alerts/:id/dismiss", authed, managerOnly, async (c) => {
  const { loc, uid } = c.get("claims");
  const r = await q(
    `UPDATE activity_alerts
        SET status = 'dismissed', resolution = 'dismissed', resolved_by = :uid, resolved_at = :t
      WHERE id = :id AND location_id = :loc AND status = 'open'`,
    { id: c.req.param("id"), loc, uid, t: now() }
  );
  if (!r.affectedRows) throw new HttpError(404, "ALERT_NOT_FOUND");
  return c.json({ ok: true });
});

app.put("/admin/settings", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  // Windows that already began under the CURRENT policy are recorded before it changes;
  // otherwise saving a new policy would silently drop them.
  await recordOpenFixedBreaks(loc);
  const b = (await c.req.json().catch(() => null)) ?? {};
  // A field absent from the body keeps its stored value (spec §5.4): a page running an older
  // bundle does not know newer fields and must not reset them. null / "" keep their meaning
  // (a cleared value, or the documented default).
  const cur = (await getSettings(loc)) ?? {};
  const has = (k) => b[k] !== undefined;
  const pick = (k) => (has(k) ? b[k] : cur[k]);

  const timezone = pick("timezone");
  if (!timezone) throw new HttpError(400, "INVALID_TIMEZONE");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new HttpError(400, "INVALID_TIMEZONE"); }
  const target = Number(pick("daily_target_hours")), max = Number(pick("max_session_hours"));
  if (!(target > 0 && target <= 24) || !(max >= 1 && max <= 24)) throw new HttpError(400, "INVALID_HOURS");
  const workStart = (has("work_start") ? b.work_start : cur.work_start) || null;
  if (workStart && !HHMM.test(workStart)) throw new HttpError(400, "INVALID_WORK_START");
  // Same-day hours only; zero-padded HH:MM compares correctly as strings.
  const workEnd = (has("work_end") ? b.work_end : cur.work_end) || null;
  if (workEnd && (!HHMM.test(workEnd) || (workStart && workEnd <= workStart))) {
    throw new HttpError(400, "INVALID_WORK_END");
  }
  const workDays = has("work_days") ? b.work_days : (cur.work_days ?? 127);
  if (!Number.isInteger(workDays) || workDays < 1 || workDays > 127) throw new HttpError(400, "INVALID_WORK_DAYS");
  // null / "" grace means the 15-minute default: an emptied UI field arrives as "" and
  // Number("") === 0, which would silently mean "late one second after work_start".
  const rawGrace = pick("late_grace_minutes");
  const grace = rawGrace === undefined || rawGrace === null || rawGrace === "" ? 15 : Number(rawGrace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) throw new HttpError(400, "INVALID_GRACE");
  if (has("breaks_enabled") && typeof b.breaks_enabled !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  // A stale tab running a much older bundle sends only breaks_enabled; map it so saving
  // there keeps a flexible-break policy instead of silently switching breaks off.
  const breakMode = b.break_mode
    ?? (has("breaks_enabled") ? (b.breaks_enabled ? "flexible" : "off") : (cur.break_mode ?? "off"));
  if (!BREAK_MODES.includes(breakMode)) throw new HttpError(400, "INVALID_BREAK_MODE");
  const breakStart = (has("break_start") ? b.break_start : cur.break_start) || null;
  const breakEnd = (has("break_end") ? b.break_end : cur.break_end) || null;
  if ((breakStart && !HHMM.test(breakStart)) || (breakEnd && !HHMM.test(breakEnd))) {
    throw new HttpError(400, "INVALID_BREAK_WINDOW");
  }
  if (breakMode === "fixed" && (!breakStart || !breakEnd || breakStart >= breakEnd)) {
    throw new HttpError(400, "INVALID_BREAK_WINDOW");
  }
  const breakPaid = has("break_paid") ? b.break_paid : Boolean(cur.break_paid);
  if (typeof breakPaid !== "boolean") throw new HttpError(400, "INVALID_BREAKS");
  const notePolicy = pick("note_on_stop") ?? "off";
  if (!NOTE_POLICIES.includes(notePolicy)) throw new HttpError(400, "INVALID_NOTE_POLICY");
  if (has("activity_monitoring") && typeof b.activity_monitoring !== "boolean") {
    throw new HttpError(400, "INVALID_ACTIVITY_MONITORING");
  }
  const monitoring = has("activity_monitoring") ? b.activity_monitoring : Boolean(cur.activity_monitoring);
  // Same empty-field rule as the grace: "" / null mean the 30-minute default.
  const rawIdle = pick("idle_minutes");
  const idleMinutes = rawIdle === undefined || rawIdle === null || rawIdle === "" ? 30 : Number(rawIdle);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 240) {
    throw new HttpError(400, "INVALID_IDLE_MINUTES");
  }

  // break_policy_since moves to now only when the break policy itself changes. It is
  // assigned FIRST so it compares against the stored values: MySQL evaluates single-table
  // SET assignments left to right (MariaDB may use the old values throughout) — both see
  // the old break_* columns here. The break_policy_since comparison is one statement; the
  // settings were read before it, so two concurrent partial saves can lose one (acceptable:
  // the app always sends the whole form).
  await q(
    `UPDATE settings SET break_policy_since = IF(break_mode <=> :breakMode AND break_start <=> :breakStart
                                                  AND break_end <=> :breakEnd AND break_paid <=> :breakPaid,
                                                  break_policy_since, :t),
                         activity_monitoring_since = IF(activity_monitoring = 0 AND :monitoring = 1,
                                                        :t, activity_monitoring_since),
                         timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         work_end = :we, work_days = :wd,
                         late_grace_minutes = :grace, max_session_hours = :max,
                         breaks_enabled = :breaksEnabled, break_mode = :breakMode,
                         break_start = :breakStart, break_end = :breakEnd, break_paid = :breakPaid,
                         activity_monitoring = :monitoring, idle_minutes = :idleMinutes,
                         note_on_stop = :notePolicy, updated_at = :t
      WHERE location_id = :loc`,
    {
      tz: timezone, target, ws: workStart, we: workEnd, wd: workDays, grace, max,
      // Kept in sync so code that still reads breaks_enabled behaves the same.
      breaksEnabled: breakMode === "flexible" ? 1 : 0, breakMode, breakStart, breakEnd,
      breakPaid: breakPaid ? 1 : 0, notePolicy, t: now(), loc,
      monitoring: monitoring ? 1 : 0, idleMinutes,
    }
  );
  // Monitoring switched off: nothing detects or ends an idle stretch any more, so the ongoing
  // ones end now (they stay open for the manager, like any other ended stretch).
  if (cur.activity_monitoring && !monitoring) {
    await q(
      `UPDATE activity_alerts SET to_at = GREATEST(from_at, :t)
        WHERE location_id = :loc AND kind = 'idle' AND status = 'open' AND to_at IS NULL`,
      { t: now(), loc }
    );
  }
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

// Logged once per process: an install event for another app is normal (GHL signs every
// app's events with one key), but a first mismatch is worth seeing in case GHL_APP_ID is wrong.
let loggedForeignAppId = false;

/**
 * Opens a "working, not clocked in" alert for one stored event when every rule of spec §5.3
 * holds: fresh event, inside working hours, an employee (not a manager) we know, and no
 * session open or ending after the event. ux_alert_nci_open keeps one open alert per employee,
 * so a burst of events — or two concurrent deliveries — opens exactly one (INSERT IGNORE).
 */
async function openNotClockedInAlert(st, loc, uid, at, t) {
  if (!isFreshEvent(at, t) || !isWithinWorkHours(st, at)) return;
  const [emp] = await q(
    `SELECT 1 AS ok FROM employees
      WHERE location_id = :loc AND user_id = :uid AND role = 'employee' AND is_active = 1`,
    { loc, uid }
  );
  if (!emp) return;
  // One statement, so a clock-in racing this event cannot leave a stale alert: nothing opens
  // while a session is open or when one ended after the event time (a late or repeated
  // delivery of an event from a shift that is already over).
  await q(
    `INSERT IGNORE INTO activity_alerts (id, location_id, user_id, session_id, kind, from_at, detected_at, status)
     SELECT :id, :loc, :uid, NULL, 'working_not_clocked_in', :at, :t, 'open' FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE location_id = :loc AND user_id = :uid
                          AND (ended_at IS NULL OR ended_at > :at))`,
    { id: randomUUID(), loc, uid, at, t }
  );
}

// GHL refuses any URL in the app settings that mentions HighLevel ("ghl"), so the public
// paths are neutral: /webhooks/events and /oauth/callback.
app.post("/webhooks/events", webhookBodyLimit, async (c) => {
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
    if (!isForOurApp(ev, GHL_APP_ID)) {
      if (!loggedForeignAppId) {
        loggedForeignAppId = true;
        console.warn("[webhook] install/uninstall for another app ignored", { appId: ev.appId ?? null });
      }
      return c.json({ ok: true });
    }
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
    const st = await getSettings(ev.locationId);
    if (st?.activity_monitoring) {
      // GHL retries a failed delivery up to 12 times, and the same message can arrive again
      // through another app with a new webhookId: the key prefers the message id.
      const webhookId = activityDedupeKey(ev, raw);
      const stored = await q(
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
      // Only an event with a user id is a person's activity (spec §2.1). A duplicate delivery
      // (nothing stored) opens nothing: its first delivery already did, or was dismissed.
      if (ev.userId && stored.affectedRows > 0) {
        await endIdleStretch(st, ev.locationId, String(ev.userId), ev.occurredAt, t)
          .catch((e) => console.error("[idle-resume]", e));
        await openNotClockedInAlert(st, ev.locationId, String(ev.userId), ev.occurredAt, t);
      }
    }
  }
  return c.json({ ok: true });
});

const DEFAULT_REDIRECT_URI = "https://timeclock.noursky.com/oauth/callback";

// A tiny self-contained Arabic page; the texts are fixed strings, never request data.
function installPage(title, message) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#F7F6FB;color:#1D1B2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:460px;background:#fff;border:1px solid #E3E0F0;border-radius:14px;padding:28px}h1{color:#6C5CE7;font-size:20px;margin:0 0 10px}p{margin:0;line-height:1.8}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

app.get("/oauth/callback", async (c) => {
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
setInterval(() => detectIdle().catch((e) => console.error("[idle-detect]", e)), 60 * 1000);
setInterval(() => purgeOldActivity().catch((e) => console.error("[activity-retention]", e)), AUTO_CLOSE_EVERY_MS);

const port = Number(env.PORT || 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[timeclock] listening on :${port}`));

export default app;
