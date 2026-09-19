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

/** Offset (seconds) of an IANA timezone from UTC at a given moment. */
function tzOffsetSec(tz, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - at.getTime()) / 1000);
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

// Seconds worked inside [from, to), clipping sessions that cross the window edges.
const WORKED_EXPR = "GREATEST(0, LEAST(COALESCE(s.ended_at, :now), :to) - GREATEST(s.started_at, :from))";

async function getSettings(loc) {
  const rows = await q("SELECT * FROM settings WHERE location_id = :loc", { loc });
  return rows[0] ?? null;
}

/**
 * Caps forgotten sessions at max_session_hours and flags them 'auto'.
 * Runs on a timer AND lazily before reads, so correctness never depends
 * on the process staying alive between requests.
 */
async function autoCloseStale(loc = null) {
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
  const { encryptedData } = await c.req.json().catch(() => ({}));
  if (!encryptedData) throw new HttpError(400, "MISSING_ENCRYPTED_DATA");

  const d = decryptSSO(encryptedData, env.GHL_SHARED_SECRET);
  const loc = d.activeLocation;
  if (!loc) throw new HttpError(403, "OPEN_FROM_SUB_ACCOUNT");

  const role = d.role === "admin" || d.type === "agency" ? "manager" : "employee";
  return c.json(await issueSession({
    userId: d.userId, loc, role, name: d.userName ?? "", email: d.email ?? "",
  }));
});

app.post("/auth/dev-login", async (c) => {
  if (env.NODE_ENV === "production") throw new HttpError(404, "DEV_LOGIN_DISABLED");
  const { role } = await c.req.json().catch(() => ({}));
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
  const from = intParam(c, "since", t - 86400);

  const open = await q(
    "SELECT id, started_at FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL",
    { uid, loc }
  );
  const total = await q(
    `SELECT COALESCE(SUM(${WORKED_EXPR}), 0) AS worked_sec
       FROM sessions s
      WHERE s.user_id = :uid AND s.location_id = :loc
        AND s.started_at < :to AND (s.ended_at IS NULL OR s.ended_at > :from)`,
    { now: t, to: t, from, uid, loc }
  );
  return c.json({ open_session: open[0] ?? null, worked_sec: Number(total[0].worked_sec), server_time: t });
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

app.post("/session/stop", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  await autoCloseStale(loc);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id, started_at FROM sessions WHERE user_id = :uid AND location_id = :loc AND ended_at IS NULL FOR UPDATE",
      { uid, loc }
    );
    if (!rows.length) throw new HttpError(409, "NO_OPEN_SESSION");
    const s = rows[0];
    const t = now();
    await conn.execute(
      "UPDATE sessions SET ended_at = :t, duration_sec = :dur, closed_by = 'user' WHERE id = :id",
      { t, dur: t - s.started_at, id: s.id }
    );
    await conn.commit();
    return c.json({ id: s.id, started_at: s.started_at, ended_at: t, duration_sec: t - s.started_at });
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
    `SELECT e.user_id, e.name, e.email, s.id AS session_id, s.started_at
       FROM employees e
       LEFT JOIN sessions s ON s.user_id = e.user_id AND s.location_id = e.location_id AND s.ended_at IS NULL
      WHERE e.location_id = :loc AND e.is_active = 1
      ORDER BY s.started_at IS NULL, e.name`,
    { loc }
  );
  return c.json({ server_time: now(), employees });
});

app.get("/admin/report", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const from = intParam(c, "from");
  const to = intParam(c, "to");
  if (to <= from) throw new HttpError(400, "INVALID_RANGE");
  await autoCloseStale(loc);

  const st = await getSettings(loc);
  const tz = st?.timezone ?? "Asia/Riyadh";

  const employees = await q(
    `SELECT e.user_id, e.name, e.email,
            COALESCE(SUM(${WORKED_EXPR}), 0)                                 AS worked_sec,
            COUNT(s.id)                                                      AS sessions_count,
            COUNT(DISTINCT DATE(FROM_UNIXTIME(s.started_at + :off)))         AS days_present,
            COALESCE(SUM(CASE WHEN s.closed_by = 'auto' THEN 1 ELSE 0 END), 0) AS auto_closed
       FROM employees e
       LEFT JOIN sessions s
              ON s.user_id = e.user_id AND s.location_id = e.location_id
             AND s.started_at < :to AND (s.ended_at IS NULL OR s.ended_at > :from)
      WHERE e.location_id = :loc AND e.is_active = 1
      GROUP BY e.user_id, e.name, e.email
      ORDER BY worked_sec DESC`,
    { now: now(), to, from, off: tzOffsetSec(tz), loc }
  );

  return c.json({
    from, to, timezone: tz,
    daily_target_hours: st?.daily_target_hours ?? 8,
    employees: employees.map((r) => ({ ...r, worked_sec: Number(r.worked_sec) })),
  });
});

app.get("/admin/sessions", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const from = intParam(c, "from");
  const to = intParam(c, "to");
  const uid = c.req.query("user_id") ?? null;
  await autoCloseStale(loc);
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
  return c.json({ sessions });
});

app.patch("/admin/sessions/:id", authed, managerOnly, async (c) => {
  const { loc, uid: editor } = c.get("claims");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "REASON_REQUIRED");
  const s = body.started_at, e = body.ended_at;
  if (!Number.isInteger(s) || !Number.isInteger(e) || e <= s || e > now()) throw new HttpError(400, "INVALID_TIMES");

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
    `SELECT e.name, e.email, s.started_at, s.ended_at, s.duration_sec, s.closed_by
       FROM sessions s
       JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = :loc AND s.started_at >= :from AND s.started_at < :to
      ORDER BY e.name, s.started_at`,
    { loc, from, to }
  );

  const fmt = (ts) => ts
    ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(Number(ts) * 1000))
    : "";
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Employee", "Email", "Start", "End", "Hours", "Closed by"],
    ...rows.map((r) => [r.name, r.email, fmt(r.started_at), fmt(r.ended_at),
      r.duration_sec ? (Number(r.duration_sec) / 3600).toFixed(2) : "", r.closed_by ?? "open"]),
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

app.put("/admin/settings", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const b = await c.req.json().catch(() => ({}));
  try { new Intl.DateTimeFormat("en", { timeZone: b.timezone }); } catch { throw new HttpError(400, "INVALID_TIMEZONE"); }
  if (!b.timezone) throw new HttpError(400, "INVALID_TIMEZONE");
  const target = Number(b.daily_target_hours), max = Number(b.max_session_hours);
  if (!(target > 0 && target <= 24) || !(max >= 1 && max <= 24)) throw new HttpError(400, "INVALID_HOURS");
  if (b.work_start && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.work_start)) throw new HttpError(400, "INVALID_WORK_START");

  await q(
    `UPDATE settings SET timezone = :tz, daily_target_hours = :target, work_start = :ws,
                         max_session_hours = :max, updated_at = :t
      WHERE location_id = :loc`,
    { tz: b.timezone, target, ws: b.work_start ?? null, max, t: now(), loc }
  );
  return c.json(await getSettings(loc));
});

/* ---------- Static SPA (must be registered AFTER all API routes) ---------- */
app.use("/*", serveStatic({ root: "./public" }));
app.get("/*", serveStatic({ path: "./public/index.html" })); // SPA fallback

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

setInterval(() => autoCloseStale().catch((e) => console.error("[auto-close]", e)), AUTO_CLOSE_EVERY_MS);

const port = Number(env.PORT || 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[timeclock] listening on :${port}`));

export default app;
