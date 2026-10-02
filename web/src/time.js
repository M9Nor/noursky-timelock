const UNITS = {
  ar: { min: "د", h: "س", late: (d) => `متأخر ${d}` },
  en: { min: "min", h: "h", late: (d) => `${d} late` },
};
const unitsFor = (locale) => UNITS[locale] ?? UNITS.ar;

export function serverOffset(serverTime) {
  return serverTime - Date.now() / 1000;
}
export function nowWithOffset(offset) {
  return Date.now() / 1000 + offset;
}
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(ss)}`;
}
export function formatHours(sec) {
  return (Math.max(0, sec) / 3600).toFixed(2);
}
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return { h: Math.floor(s / 3600), mm: pad(Math.floor((s % 3600) / 60)), ss: pad(s % 60) };
}
export function formatLateness(sec, locale = "ar") {
  const u = unitsFor(locale);
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  // Round up: a session one second past the grace window is still a late arrival,
  // and "late 0 min" would read as if it were on time.
  const m = Math.ceil(s / 60);
  if (m < 60) return u.late(`${m} ${u.min}`);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return u.late(mm ? `${h} ${u.h} ${mm} ${u.min}` : `${h} ${u.h}`);
}
export function formatStamp(ts, timeZone, { year = true } = {}) {
  if (!ts) return "—";
  const d = new Date(Number(ts) * 1000);
  const opts = { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false };
  if (year) opts.year = "numeric";
  try {
    return new Intl.DateTimeFormat("en-GB", timeZone ? { ...opts, timeZone } : opts).format(d);
  } catch {
    // A stored timezone Intl rejects must not take the whole table down.
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  }
}
export function formatBreak(sec, locale = "ar") {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  return `${Math.max(1, Math.round(s / 60))} ${unitsFor(locale).min}`;
}

const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/**
 * Live session and day totals at client time `nowS` (server clock). The server's numbers
 * are exact at `server_time`; only the seconds since then are added — nothing during an
 * employee break, and nothing for the part of an unpaid fixed window after server_time.
 */
export function liveTotals(status, nowS) {
  const open = status?.open_session;
  const onBreak = Boolean(status?.open_break);
  const fb = status?.fixed_break;
  const inFixed = Boolean(open && fb && nowS >= fb.starts_at && nowS < fb.ends_at);
  let since = 0;
  if (open && !onBreak) {
    since = Math.max(0, nowS - status.server_time);
    if (fb && !fb.paid) since -= overlap(status.server_time, nowS, fb.starts_at, fb.ends_at);
  }
  return {
    sessionSec: open ? status.server_time - open.started_at - (open.break_sec ?? 0) + since : 0,
    todaySec: (status?.worked_sec ?? 0) + since,
    onBreak,
    inFixed,
  };
}

export function formatTime(ts, timeZone) {
  if (!ts) return "—";
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    return new Intl.DateTimeFormat("en-GB", timeZone ? { ...opts, timeZone } : opts).format(new Date(Number(ts) * 1000));
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(Number(ts) * 1000));
  }
}
export function formatIdle(sec, locale = "ar") {
  const u = unitsFor(locale);
  if (sec == null || !Number.isFinite(Number(sec))) return "—";
  const m = Math.floor(Number(sec) / 60);
  if (m < 60) return `${m} ${u.min}`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} ${u.h} ${mm} ${u.min}` : `${h} ${u.h}`;
}
