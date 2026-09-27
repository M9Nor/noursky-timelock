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
export function formatLateness(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  // Round up: a session one second past the grace window is still a late arrival,
  // and "متأخر 0 د" would read as if it were on time.
  const m = Math.ceil(s / 60);
  if (m < 60) return `متأخر ${m} د`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `متأخر ${h} س ${mm} د` : `متأخر ${h} س`;
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
