import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_DAYS, localWeekday, isWithinWorkHours, isFreshEvent, activeSeconds, lastActivityAt, idleSeconds, sessionSummary,
} from "./activity.js";

const utc = (...a) => Date.UTC(...a) / 1000;
const DUBAI = { timezone: "Asia/Dubai", work_start: "09:00", work_end: "17:00", work_days: ALL_DAYS };

test("localWeekday uses the location's date, not UTC's", () => {
  // 2026-10-04 21:30Z is Sunday in UTC but already Monday 01:30 in Dubai (UTC+4).
  assert.equal(localWeekday("UTC", utc(2026, 9, 4, 21, 30)), 0);
  assert.equal(localWeekday("Asia/Dubai", utc(2026, 9, 4, 21, 30)), 1);
});

test("isWithinWorkHours: start is inclusive, end is exclusive, in local time", () => {
  // Monday 2026-10-05; 09:00 Dubai = 05:00Z, 17:00 Dubai = 13:00Z.
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 5, 0, 0)), true);
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 4, 59, 59)), false);
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 12, 59, 59)), true);
  assert.equal(isWithinWorkHours(DUBAI, utc(2026, 9, 5, 13, 0, 0)), false);
});

test("isWithinWorkHours follows a DST change (Europe/Berlin 09:00–17:00)", () => {
  const berlin = { timezone: "Europe/Berlin", work_start: "09:00", work_end: "17:00", work_days: ALL_DAYS };
  // 07:30Z is 08:30 CET on Friday 2026-03-27 but 09:30 CEST on Monday 2026-03-30.
  assert.equal(isWithinWorkHours(berlin, utc(2026, 2, 27, 7, 30)), false);
  assert.equal(isWithinWorkHours(berlin, utc(2026, 2, 30, 7, 30)), true);
});

test("isWithinWorkHours skips days off, judged by the local weekday", () => {
  const noFriday = { ...DUBAI, work_days: ALL_DAYS & ~(1 << 5) };
  assert.equal(isWithinWorkHours(noFriday, utc(2026, 9, 2, 6, 0)), false); // Fri 10:00 Dubai
  assert.equal(isWithinWorkHours(noFriday, utc(2026, 9, 1, 6, 0)), true);  // Thu 10:00 Dubai
  const allDay = { timezone: "Asia/Dubai", work_start: "00:00", work_end: "23:59" };
  assert.equal(isWithinWorkHours({ ...allDay, work_days: 1 << 1 }, utc(2026, 9, 4, 21, 30)), true);  // Mon locally
  assert.equal(isWithinWorkHours({ ...allDay, work_days: 1 << 0 }, utc(2026, 9, 4, 21, 30)), false); // not Sun locally
});

test("isWithinWorkHours is false while either time is missing or the window is empty", () => {
  const ts = utc(2026, 9, 5, 6, 0);
  assert.equal(isWithinWorkHours({ ...DUBAI, work_end: null }, ts), false);
  assert.equal(isWithinWorkHours({ ...DUBAI, work_start: null }, ts), false);
  assert.equal(isWithinWorkHours({ ...DUBAI, work_start: "17:00", work_end: "09:00" }, ts), false);
  assert.equal(isWithinWorkHours(null, ts), false);
});

test("isFreshEvent accepts up to 6 hours old and 5 minutes ahead", () => {
  const now = 1_800_000_000;
  assert.equal(isFreshEvent(now - 6 * 3600, now), true);
  assert.equal(isFreshEvent(now - 6 * 3600 - 1, now), false);
  assert.equal(isFreshEvent(now + 300, now), true);
  assert.equal(isFreshEvent(now + 301, now), false);
});

test("activeSeconds removes break time once, even when breaks overlap or are still open", () => {
  assert.equal(activeSeconds(0, 100), 100);
  assert.equal(activeSeconds(0, 100, [[10, 30], [20, 40]]), 70);  // union 10–40 = 30
  assert.equal(activeSeconds(0, 100, [[-50, 10], [90, null]]), 80); // clipped; open break runs to 100
  assert.equal(activeSeconds(100, 100, [[0, 200]]), 0);
});

test("lastActivityAt / idleSeconds take the latest of start, monitoring start and last event", () => {
  assert.equal(lastActivityAt({ startedAt: 100, monitoringSince: null, lastEventAt: null }), 100);
  assert.equal(lastActivityAt({ startedAt: 100, monitoringSince: 500, lastEventAt: 300 }), 500);
  assert.equal(idleSeconds({ startedAt: 0, lastEventAt: 1000, now: 4600 }), 3600);
  assert.equal(idleSeconds({ startedAt: 0, lastEventAt: 1000, now: 4600, breaks: [[2000, 2600]] }), 3000);
  assert.equal(idleSeconds({ startedAt: 0, monitoringSince: 4000, lastEventAt: 1000, now: 4600 }), 600);
});

test("sessionSummary counts the monitored part only, with breaks removed from gaps", () => {
  const s = sessionSummary({
    startedAt: 0, endedAt: 10_000, monitoringSince: 0,
    eventTimes: [3000, 1000, 20_000], // 20 000 is after the session: ignored
    breaks: [[5000, 6000]],
  });
  // points 0,1000,3000,10000 → gaps 1000, 2000, 7000 − 1000 (break) = 6000
  assert.deepEqual(s, { activity_count: 2, last_activity_at: 3000, longest_idle_sec: 6000 });
  assert.deepEqual(
    sessionSummary({ startedAt: 0, endedAt: 1000, monitoringSince: 400, eventTimes: [100] }),
    { activity_count: 0, last_activity_at: null, longest_idle_sec: 600 });
  assert.equal(sessionSummary({ startedAt: 0, endedAt: 1000, monitoringSince: null, eventTimes: [] }), null);
  assert.equal(sessionSummary({ startedAt: 0, endedAt: 1000, monitoringSince: 1000, eventTimes: [] }), null);
});
