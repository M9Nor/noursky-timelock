/* Timezone helpers. All timestamps are UNIX seconds (UTC); MySQL runs in UTC and local
 * days are derived by adding the location's offset explicitly (see server.js pool). */

const DAY = 86400;
// Longest span walked day-by-day when looking for offset changes (~10 years). Instants
// before it reuse the earliest offset found, which keeps a hostile ?from=0 cheap.
const MAX_WALK_DAYS = 3700;

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset (seconds) of an IANA timezone from UTC at a given moment. */
export function tzOffsetSec(tz, at = new Date()) {
  // Intl reports whole seconds, so compare against a whole-second instant: a Date that
  // still carries milliseconds would otherwise come out up to one second short.
  const whole = Math.floor(at.getTime() / 1000) * 1000;
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(whole)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - whole) / 1000;
}

/**
 * The zone's UTC offset over [fromTs, toTs] as contiguous segments `{ start, off }`
 * (the first starts at -Infinity). A range spanning a DST change therefore maps every
 * instant to the offset in force at that instant, not the one in force "now".
 * Changes are found by stepping a day at a time and bisecting to the exact second —
 * every real-world offset lasts far longer than a day.
 */
export function tzSegments(tz, fromTs, toTs) {
  const offAt = (ts) => tzOffsetSec(tz, new Date(ts * 1000));
  const start = Math.max(fromTs, toTs - MAX_WALK_DAYS * DAY);
  const segs = [{ start: -Infinity, off: offAt(start) }];
  let prevTs = start;
  let prevOff = segs[0].off;
  while (prevTs < toTs) {
    const cur = Math.min(prevTs + DAY, toTs);
    const off = offAt(cur);
    if (off !== prevOff) {
      let lo = prevTs, hi = cur; // offAt(lo) === prevOff, offAt(hi) === off
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offAt(mid) === prevOff) lo = mid; else hi = mid;
      }
      segs.push({ start: hi, off });
      prevOff = off;
    }
    prevTs = cur;
  }
  return segs;
}

// Only plain column references or named placeholders are ever interpolated into SQL.
const SQL_OPERAND = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$|^:[a-z_][a-z0-9_]*$/i;

/** Local-time view of a location over a window, for both JS and SQL. */
export function localZone(tz, fromTs, toTs) {
  const segs = tzSegments(tz, fromTs, toTs);
  const offAt = (ts) => {
    let off = segs[0].off;
    for (const s of segs) if (ts >= s.start) off = s.off;
    return off;
  };
  const local = (ts) => Number(ts) + offAt(Number(ts));

  function sqlOffset(col) {
    if (!SQL_OPERAND.test(col)) throw new Error(`unexpected SQL operand: ${col}`);
    if (segs.length === 1) return String(segs[0].off);
    const whens = segs.slice(1).reverse().map((s) => `WHEN ${col} >= ${s.start} THEN ${s.off}`);
    return `CASE ${whens.join(" ")} ELSE ${segs[0].off} END`;
  }

  return {
    offAt,
    /** Seconds since local midnight. */
    localTod: (ts) => ((local(ts) % DAY) + DAY) % DAY,
    /** An integer that is equal for two instants iff they fall on the same local day. */
    localDayKey: (ts) => Math.floor(local(ts) / DAY),
    /** Local calendar date as YYYY-MM-DD, comparable with SQL DATE(). */
    dayStr: (ts) => new Date(local(ts) * 1000).toISOString().slice(0, 10),
    /** SQL expression for the local calendar date of a UNIX-seconds column. */
    sqlLocalDate: (col) => `DATE(FROM_UNIXTIME(${col} + ${sqlOffset(col)}))`,
  };
}

/** Local calendar date { y, m, d } of an instant in a zone. */
export function localDate(tz, ts) {
  const p = Object.fromEntries(
    formatter(tz).formatToParts(new Date(Math.floor(Number(ts)) * 1000)).map((x) => [x.type, x.value])
  );
  return { y: +p.year, m: +p.month, d: +p.day };
}

/** UTC seconds of a local wall-clock time ("HH:MM") on a local date. DST-aware. */
export function wallToUtc(tz, { y, m, d }, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  // Two passes: the first lands within one offset of the answer, the second uses the
  // offset actually in force at that instant (they differ only around a DST change).
  const first = asIfUtc - tzOffsetSec(tz, new Date(asIfUtc * 1000));
  return asIfUtc - tzOffsetSec(tz, new Date(first * 1000));
}

/** A daily local window as UTC [start, end] pairs, one per local date in [fromTs, toTs]. */
export function fixedWindows(tz, fromTs, toTs, start, end) {
  const out = [];
  const key = (x) => x.y * 10000 + x.m * 100 + x.d;
  const last = key(localDate(tz, toTs));
  for (let cur = localDate(tz, fromTs); key(cur) <= last;) {
    out.push([wallToUtc(tz, cur, start), wallToUtc(tz, cur, end)]);
    const next = new Date(Date.UTC(cur.y, cur.m - 1, cur.d + 1));
    cur = { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
  }
  return out;
}

const dateKey = (x) => x.y * 10000 + x.m * 100 + x.d;

/** UTC seconds of the first instant of a local date. DST-aware. */
function dayStartUtc(tz, date) {
  const s = wallToUtc(tz, date, "00:00");
  if (dateKey(localDate(tz, s)) >= dateKey(date)) return s;
  // Where a DST change skips midnight itself (e.g. Chile, 00:00 → 01:00), "00:00" maps to
  // an instant still on the previous day; the day starts at the change, so bisect to it.
  let lo = s, hi = s + 3 * 3600;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(localDate(tz, mid)) < dateKey(date)) lo = mid; else hi = mid;
  }
  return hi;
}

/**
 * UTC bounds [dayStart, nextDayStart) of the local calendar day containing `ts`.
 * DST-aware: a spring-forward day is 23h long, a fall-back day 25h.
 */
export function localDayBounds(tz, ts) {
  const d = localDate(tz, ts);
  const n = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
  const next = { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() };
  return [dayStartUtc(tz, d), dayStartUtc(tz, next)];
}
