/**
 * NourSky TimeClock — Cloudflare Worker (Phase 1)
 * GHL Private Marketplace App · Custom Page + SSO (Shared Secret)
 */

export interface Env {
  DB: D1Database;
  GHL_SHARED_SECRET: string; // from GHL app → Advanced Settings → Auth → Shared Secret
  SESSION_SECRET: string;    // random 32+ chars, signs our own session tokens
  ALLOWED_ORIGIN: string;
}

type Role = "manager" | "employee";
interface Claims { uid: string; loc: string; role: Role; name: string; email: string; exp: number }

const SESSION_TTL = 12 * 3600;
const enc = new TextEncoder();
const dec = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function cors(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Vary": "Origin",
  };
}

function json(env: Env, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(env) },
  });
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s: string) => b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

function intParam(url: URL, key: string, fallback?: number): number {
  const v = url.searchParams.get(key);
  if (v === null) {
    if (fallback === undefined) throw new HttpError(400, `MISSING_${key.toUpperCase()}`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `INVALID_${key.toUpperCase()}`);
  return n;
}

/** Offset (seconds) of an IANA timezone from UTC at a given moment. */
function tzOffsetSec(tz: string, at = new Date()): number {
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

async function decryptSSO(encrypted: string, secret: string): Promise<any> {
  const raw = b64ToBytes(encrypted);
  if (dec.decode(raw.slice(0, 8)) !== "Salted__") throw new HttpError(400, "SSO_BAD_FORMAT");
  const salt = raw.slice(8, 16);
  const ct = raw.slice(16);
  const pass = enc.encode(secret);

  // OpenSSL EVP_BytesToKey (MD5) → 32-byte key + 16-byte IV
  let prev: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let derived: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  while (derived.length < 48) {
    prev = new Uint8Array(await crypto.subtle.digest("MD5", concat(prev, pass, salt)));
    derived = concat(derived, prev);
  }
  const key = await crypto.subtle.importKey("raw", derived.slice(0, 32), { name: "AES-CBC" }, false, ["decrypt"]);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: derived.slice(32, 48) }, key, ct);
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new HttpError(401, "SSO_DECRYPT_FAILED");
  }
}

/* ------------------------------------------------------------------ */
/* Our own session token (HMAC-SHA256)                                 */
/* ------------------------------------------------------------------ */

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signToken(claims: Claims, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function auth(req: Request, env: Env): Promise<Claims> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new HttpError(401, "UNAUTHORIZED");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), b64urlToBytes(sig), enc.encode(body));
  if (!ok) throw new HttpError(401, "UNAUTHORIZED");
  const claims = JSON.parse(dec.decode(b64urlToBytes(body))) as Claims;
  if (claims.exp < now()) throw new HttpError(401, "TOKEN_EXPIRED");
  return claims;
}

function requireManager(c: Claims) {
  if (c.role !== "manager") throw new HttpError(403, "FORBIDDEN");
}

/* ------------------------------------------------------------------ */
/* Shared SQL                                                          */
/* ------------------------------------------------------------------ */

// Seconds worked inside [from, to), clipping sessions that cross the window edges.
const WORKED_EXPR = `MAX(0, MIN(COALESCE(s.ended_at, :now), :to) - MAX(s.started_at, :from))`;

async function getSettings(env: Env, loc: string) {
  return (await env.DB.prepare("SELECT * FROM settings WHERE location_id = ?").bind(loc).first()) as any;
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function ssoLogin(req: Request, env: Env) {
  const { encryptedData } = (await req.json().catch(() => ({}))) as { encryptedData?: string };
  if (!encryptedData) throw new HttpError(400, "MISSING_ENCRYPTED_DATA");

  const d = await decryptSSO(encryptedData, env.GHL_SHARED_SECRET);
  const loc: string | undefined = d.activeLocation;
  if (!loc) throw new HttpError(403, "OPEN_FROM_SUB_ACCOUNT");

  const role: Role = d.role === "admin" || d.type === "agency" ? "manager" : "employee";
  const t = now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO employees (user_id, location_id, name, email, role, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(user_id, location_id) DO UPDATE SET
         name = excluded.name, email = excluded.email, role = excluded.role, updated_at = excluded.updated_at`
    ).bind(d.userId, loc, d.userName ?? null, d.email ?? null, role, t),
    env.DB.prepare("INSERT OR IGNORE INTO settings (location_id) VALUES (?)").bind(loc),
  ]);

  const claims: Claims = { uid: d.userId, loc, role, name: d.userName ?? "", email: d.email ?? "", exp: t + SESSION_TTL };
  return json(env, { token: await signToken(claims, env.SESSION_SECRET), user: { ...claims, exp: undefined } });
}

async function myStatus(c: Claims, url: URL, env: Env) {
  const t = now();
  const from = intParam(url, "since", t - 86400);
  const open = await env.DB.prepare(
    "SELECT id, started_at FROM sessions WHERE user_id = ? AND location_id = ? AND ended_at IS NULL"
  ).bind(c.uid, c.loc).first();

  const total = await env.DB.prepare(rewriteNamed(
    `SELECT COALESCE(SUM(${WORKED_EXPR}), 0) AS worked_sec
       FROM sessions s
      WHERE s.user_id = :uid AND s.location_id = :loc
        AND s.started_at < :to AND (s.ended_at IS NULL OR s.ended_at > :from)`
  )).bind(...namedBind({ now: t, to: t, from, uid: c.uid, loc: c.loc })).first<{ worked_sec: number }>();

  return json(env, { open_session: open ?? null, worked_sec: total?.worked_sec ?? 0, server_time: t });
}

async function startSession(c: Claims, env: Env) {
  const id = crypto.randomUUID();
  const t = now();
  try {
    await env.DB.prepare("INSERT INTO sessions (id, user_id, location_id, started_at) VALUES (?, ?, ?, ?)")
      .bind(id, c.uid, c.loc, t).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "SESSION_ALREADY_OPEN");
    throw e;
  }
  return json(env, { id, started_at: t }, 201);
}

async function stopSession(c: Claims, env: Env) {
  const t = now();
  const row = await env.DB.prepare(
    `UPDATE sessions SET ended_at = ?1, duration_sec = ?1 - started_at, closed_by = 'user'
      WHERE user_id = ?2 AND location_id = ?3 AND ended_at IS NULL
      RETURNING id, started_at, ended_at, duration_sec`
  ).bind(t, c.uid, c.loc).first();
  if (!row) throw new HttpError(409, "NO_OPEN_SESSION");
  return json(env, row);
}

async function adminLive(c: Claims, env: Env) {
  requireManager(c);
  const { results } = await env.DB.prepare(
    `SELECT e.user_id, e.name, e.email, s.id AS session_id, s.started_at
       FROM employees e
       LEFT JOIN sessions s ON s.user_id = e.user_id AND s.location_id = e.location_id AND s.ended_at IS NULL
      WHERE e.location_id = ? AND e.is_active = 1
      ORDER BY s.started_at IS NULL, e.name`
  ).bind(c.loc).all();
  return json(env, { server_time: now(), employees: results });
}

async function adminReport(c: Claims, url: URL, env: Env) {
  requireManager(c);
  const from = intParam(url, "from");
  const to = intParam(url, "to");
  if (to <= from) throw new HttpError(400, "INVALID_RANGE");

  const st = await getSettings(env, c.loc);
  const off = tzOffsetSec(st?.timezone ?? "Asia/Riyadh");

  const { results } = await env.DB.prepare(rewriteNamed(
    `SELECT e.user_id, e.name, e.email,
            COALESCE(SUM(${WORKED_EXPR}), 0)                              AS worked_sec,
            COUNT(s.id)                                                   AS sessions_count,
            COUNT(DISTINCT date(s.started_at + :off, 'unixepoch'))        AS days_present,
            COALESCE(SUM(CASE WHEN s.closed_by = 'auto' THEN 1 END), 0)   AS auto_closed
       FROM employees e
       LEFT JOIN sessions s
              ON s.user_id = e.user_id AND s.location_id = e.location_id
             AND s.started_at < :to AND (s.ended_at IS NULL OR s.ended_at > :from)
      WHERE e.location_id = :loc AND e.is_active = 1
      GROUP BY e.user_id
      ORDER BY worked_sec DESC`
  )).bind(...namedBind({ now: now(), to, from, off, loc: c.loc })).all();

  return json(env, {
    from, to,
    daily_target_hours: st?.daily_target_hours ?? 8,
    timezone: st?.timezone ?? "Asia/Riyadh",
    employees: results,
  });
}

async function adminSessions(c: Claims, url: URL, env: Env) {
  requireManager(c);
  const from = intParam(url, "from");
  const to = intParam(url, "to");
  const uid = url.searchParams.get("user_id");
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.user_id, e.name, s.started_at, s.ended_at, s.duration_sec, s.closed_by
       FROM sessions s JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3
        AND (?4 IS NULL OR s.user_id = ?4)
      ORDER BY s.started_at DESC LIMIT 1000`
  ).bind(c.loc, from, to, uid).all();
  return json(env, { sessions: results });
}

async function adminEditSession(c: Claims, id: string, req: Request, env: Env) {
  requireManager(c);
  const body = (await req.json().catch(() => ({}))) as { started_at?: number; ended_at?: number; reason?: string };
  const reason = (body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "REASON_REQUIRED");
  if (!Number.isInteger(body.started_at) || !Number.isInteger(body.ended_at)) throw new HttpError(400, "INVALID_TIMES");
  const s = body.started_at!, e = body.ended_at!;
  if (e <= s || e > now()) throw new HttpError(400, "INVALID_TIMES");

  const old = await env.DB.prepare("SELECT * FROM sessions WHERE id = ? AND location_id = ?").bind(id, c.loc).first<any>();
  if (!old) throw new HttpError(404, "SESSION_NOT_FOUND");

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sessions SET started_at = ?, ended_at = ?, duration_sec = ?, closed_by = 'admin' WHERE id = ? AND location_id = ?"
    ).bind(s, e, e - s, id, c.loc),
    env.DB.prepare(
      `INSERT INTO edits_log (id, session_id, location_id, editor_user_id, old_started_at, old_ended_at,
                              new_started_at, new_ended_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), id, c.loc, c.uid, old.started_at, old.ended_at, s, e, reason),
  ]);
  return json(env, { id, started_at: s, ended_at: e, duration_sec: e - s, closed_by: "admin" });
}

async function adminExportCsv(c: Claims, url: URL, env: Env) {
  requireManager(c);
  const from = intParam(url, "from");
  const to = intParam(url, "to");
  const st = await getSettings(env, c.loc);
  const tz = st?.timezone ?? "Asia/Riyadh";
  const { results } = await env.DB.prepare(
    `SELECT e.name, e.email, s.started_at, s.ended_at, s.duration_sec, s.closed_by
       FROM sessions s JOIN employees e ON e.user_id = s.user_id AND e.location_id = s.location_id
      WHERE s.location_id = ? AND s.started_at >= ? AND s.started_at < ?
      ORDER BY e.name, s.started_at`
  ).bind(c.loc, from, to).all<any>();

  const fmt = (ts: number | null) =>
    ts ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(ts * 1000)) : "";
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Employee", "Email", "Start", "End", "Hours", "Closed by"],
    ...results.map((r) => [r.name, r.email, fmt(r.started_at), fmt(r.ended_at),
      r.duration_sec ? (r.duration_sec / 3600).toFixed(2) : "", r.closed_by ?? "open"]),
  ];
  const csv = "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n"); // BOM so Excel reads Arabic names
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="timeclock-${from}-${to}.csv"`,
      ...cors(env),
    },
  });
}

async function getSettingsRoute(c: Claims, env: Env) {
  requireManager(c);
  return json(env, await getSettings(env, c.loc));
}

async function putSettings(c: Claims, req: Request, env: Env) {
  requireManager(c);
  const b = (await req.json().catch(() => ({}))) as any;
  try { new Intl.DateTimeFormat("en", { timeZone: b.timezone }); } catch { throw new HttpError(400, "INVALID_TIMEZONE"); }
  const target = Number(b.daily_target_hours), max = Number(b.max_session_hours);
  if (!(target > 0 && target <= 24) || !(max >= 1 && max <= 24)) throw new HttpError(400, "INVALID_HOURS");
  if (b.work_start && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.work_start)) throw new HttpError(400, "INVALID_WORK_START");

  await env.DB.prepare(
    `UPDATE settings SET timezone = ?, daily_target_hours = ?, work_start = ?, max_session_hours = ?, updated_at = ?
      WHERE location_id = ?`
  ).bind(b.timezone, target, b.work_start ?? null, max, now(), c.loc).run();
  return json(env, await getSettings(env, c.loc));
}

/* ------------------------------------------------------------------ */
/* Named-parameter helper: D1 binds positionally, so map :names → ?N   */
/* ------------------------------------------------------------------ */
// Usage: env.DB.prepare(rewriteNamed(sql)).bind(...namedBind(obj))
// :now=?1 :to=?2 :from=?3 :off=?4 :uid=?5 :loc=?6 (unused slots are bound to null)
const NAMED_ORDER = ["now", "to", "from", "off", "uid", "loc"] as const;
function namedBind(o: Partial<Record<(typeof NAMED_ORDER)[number], unknown>>): unknown[] {
  return NAMED_ORDER.map((k) => o[k] ?? null);
}
function rewriteNamed(sql: string): string {
  return sql.replace(/:(now|to|from|off|uid|loc)\b/g, (_, k) => `?${NAMED_ORDER.indexOf(k) + 1}`);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "");
    const m = req.method;

    try {
      if (m === "POST" && p === "/auth/sso") return await ssoLogin(req, env);

      const c = await auth(req, env);
      if (m === "GET"  && p === "/me/status")        return await myStatus(c, url, env);
      if (m === "POST" && p === "/session/start")    return await startSession(c, env);
      if (m === "POST" && p === "/session/stop")     return await stopSession(c, env);
      if (m === "GET"  && p === "/admin/live")       return await adminLive(c, env);
      if (m === "GET"  && p === "/admin/report")     return await adminReport(c, url, env);
      if (m === "GET"  && p === "/admin/sessions")   return await adminSessions(c, url, env);
      if (m === "GET"  && p === "/admin/export.csv") return await adminExportCsv(c, url, env);
      if (m === "GET"  && p === "/admin/settings")   return await getSettingsRoute(c, env);
      if (m === "PUT"  && p === "/admin/settings")   return await putSettings(c, req, env);

      const edit = p.match(/^\/admin\/sessions\/([\w-]+)$/);
      if (m === "PATCH" && edit) return await adminEditSession(c, edit[1], req, env);

      throw new HttpError(404, "NOT_FOUND");
    } catch (e) {
      if (e instanceof HttpError) return json(env, { error: e.code }, e.status);
      console.error(e);
      return json(env, { error: "INTERNAL_ERROR" }, 500);
    }
  },

  // Cron: cap forgotten sessions at max_session_hours and flag them 'auto' for manager review
  async scheduled(_evt: ScheduledController, env: Env): Promise<void> {
    await env.DB.prepare(
      `UPDATE sessions
          SET ended_at     = started_at + CAST(COALESCE((SELECT max_session_hours FROM settings st WHERE st.location_id = sessions.location_id), 12) * 3600 AS INTEGER),
              duration_sec = CAST(COALESCE((SELECT max_session_hours FROM settings st WHERE st.location_id = sessions.location_id), 12) * 3600 AS INTEGER),
              closed_by    = 'auto'
        WHERE ended_at IS NULL
          AND ?1 - started_at > COALESCE((SELECT max_session_hours FROM settings st WHERE st.location_id = sessions.location_id), 12) * 3600`
    ).bind(now()).run();
  },
};
