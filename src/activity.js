/* Activity monitoring rules (spec §5.3, §5.6). Pure functions: no database, no clock. */
import { localDate, wallToUtc } from "./tz.js";

/** A not-clocked-in alert is opened only by an event at most this old … */
export const ALERT_MAX_AGE_SEC = 6 * 3600;
/** … and at most this far in the future (clock skew), so a replay or a late retry opens nothing. */
export const ALERT_MAX_SKEW_SEC = 5 * 60;
/** work_days bitmask with every weekday set (bit 0 = Sunday … bit 6 = Saturday). */
export const ALL_DAYS = 127;

/** Weekday (0 = Sunday … 6 = Saturday) of the local date holding `ts`. */
export function localWeekday(tz, ts) {
  const { y, m, d } = localDate(tz, ts);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * True when `ts` falls on a working day, at or after work_start and before work_end, in the
 * location's timezone (DST-aware). Either time missing → false: no not-clocked-in alerts
 * until the manager sets both.
 */
export function isWithinWorkHours(st, ts) {
  if (!st?.work_start || !st?.work_end || st.work_start >= st.work_end) return false;
  const tz = st.timezone || "Asia/Riyadh";
  const days = st.work_days == null ? ALL_DAYS : Number(st.work_days);
  if (!(days & (1 << localWeekday(tz, ts)))) return false;
  const day = localDate(tz, ts);
  return ts >= wallToUtc(tz, day, st.work_start) && ts < wallToUtc(tz, day, st.work_end);
}

/** True for an event recent enough to open an alert (see ALERT_MAX_AGE_SEC / _SKEW_SEC). */
export function isFreshEvent(occurredAt, now) {
  return occurredAt >= now - ALERT_MAX_AGE_SEC && occurredAt <= now + ALERT_MAX_SKEW_SEC;
}

/** Union of [start, end] intervals (end null = still running), clipped to [from, until]. */
function clipMerge(intervals, from, until) {
  const xs = intervals
    .map(([s, e]) => [Math.max(Number(s), from), Math.min(e == null ? until : Number(e), until)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Seconds of [from, until] not covered by any break (overlapping breaks count once). */
export function activeSeconds(from, until, breaks = []) {
  if (until <= from) return 0;
  const covered = clipMerge(breaks, from, until).reduce((sum, [s, e]) => sum + (e - s), 0);
  return until - from - covered;
}

/** The latest of the session start, the monitoring start and the last counted event. */
export function lastActivityAt({ startedAt, monitoringSince = null, lastEventAt = null }) {
  return Math.max(...[startedAt, monitoringSince, lastEventAt].filter((x) => x != null).map(Number));
}

/** Idle seconds of an open session at `now`: time since the last activity, breaks removed. */
export function idleSeconds({ startedAt, monitoringSince = null, lastEventAt = null, now, breaks = [] }) {
  return activeSeconds(lastActivityAt({ startedAt, monitoringSince, lastEventAt }), now, breaks);
}

/**
 * Activity summary of a closed session (spec §5.6), or null when monitoring never covered
 * it. Only the monitored part counts: from max(start, monitoringSince) to the end.
 * `eventTimes` are this employee's counted events (rows with a user id).
 */
export function sessionSummary({ startedAt, endedAt, monitoringSince, eventTimes = [], breaks = [] }) {
  const end = Number(endedAt);
  if (monitoringSince == null || Number(monitoringSince) >= end) return null;
  const from = Math.max(Number(startedAt), Number(monitoringSince));
  const events = eventTimes.map(Number).filter((x) => x >= from && x <= end).sort((a, b) => a - b);
  const points = [from, ...events, end];
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    longest = Math.max(longest, activeSeconds(points[i - 1], points[i], breaks));
  }
  return {
    activity_count: events.length,
    last_activity_at: events.length ? events[events.length - 1] : null,
    longest_idle_sec: longest,
  };
}

/** True while `now` falls inside any break interval (end null = still running). */
export function onBreakAt(breaks, now) {
  return breaks.some(([s, e]) => Number(s) <= now && (e == null || now < Number(e)));
}

/**
 * Phase C (spec §12.1): the `from_at` of an idle alert to open for an open session at `now`,
 * or null. Opens once the idle time (breaks removed) reaches idle_minutes, never while the
 * employee is on a break or inside the fixed window (both are in `breaks`).
 */
export function idleAlertAt({ startedAt, monitoringSince = null, lastEventAt = null, now, breaks = [], idleMinutes }) {
  if (onBreakAt(breaks, now)) return null;
  const from = lastActivityAt({ startedAt, monitoringSince, lastEventAt });
  return activeSeconds(from, now, breaks) >= idleMinutes * 60 ? from : null;
}

/**
 * Spec §12.2: an event at `occurredAt` that ends an idle stretch begun at `fromAt` too early
 * for the stretch to have reached the threshold — a delayed GHL delivery — so the alert is
 * resolved as late activity instead of being kept.
 */
export function isLateActivity({ fromAt, occurredAt, breaks = [], idleMinutes }) {
  return activeSeconds(Number(fromAt), Number(occurredAt), breaks) < idleMinutes * 60;
}
