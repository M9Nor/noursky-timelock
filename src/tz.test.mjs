import { test } from "node:test";
import assert from "node:assert/strict";
import { tzOffsetSec, tzSegments, localZone, localDate, wallToUtc, fixedWindows, localDayBounds } from "./tz.js";

const utc = (...a) => Date.UTC(...a) / 1000;

test("tzOffsetSec is exact even when the Date carries milliseconds", () => {
  // Intl formats whole seconds; comparing that against a Date with a 999ms tail used to
  // come out as 10799 instead of 10800.
  assert.equal(tzOffsetSec("Asia/Riyadh", new Date(Date.UTC(2026, 8, 24, 12, 0, 0, 999))), 10800);
  assert.equal(tzOffsetSec("Asia/Riyadh", new Date(Date.UTC(2026, 8, 24, 12, 0, 0, 0))), 10800);
  assert.equal(tzOffsetSec("America/New_York", new Date(Date.UTC(2026, 0, 15, 12, 0, 0, 500))), -18000);
});

test("tzSegments: a zone without DST has a single segment", () => {
  const segs = tzSegments("Asia/Riyadh", utc(2026, 0, 1), utc(2026, 11, 31));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].off, 10800);
});

test("tzSegments finds the exact second Europe/Berlin moves to summer time", () => {
  const segs = tzSegments("Europe/Berlin", utc(2026, 2, 1), utc(2026, 3, 30));
  assert.equal(segs.length, 2);
  assert.equal(segs[0].off, 3600);
  assert.deepEqual(segs[1], { start: utc(2026, 2, 29, 1), off: 7200 });
});

test("tzSegments finds both changes in a range spanning a whole year", () => {
  const segs = tzSegments("Europe/Berlin", utc(2026, 0, 1), utc(2026, 11, 31));
  assert.deepEqual(segs.map((s) => s.off), [3600, 7200, 3600]);
  assert.equal(segs[2].start, utc(2026, 9, 25, 1));
});

test("localZone maps each instant with the offset in force at that instant", () => {
  const z = localZone("Europe/Berlin", utc(2026, 2, 1), utc(2026, 3, 30));
  // 07:30Z is 08:30 local in winter (CET) but 09:30 local in summer (CEST).
  assert.equal(z.localTod(utc(2026, 2, 20, 7, 30)), 8 * 3600 + 30 * 60);
  assert.equal(z.localTod(utc(2026, 3, 10, 7, 30)), 9 * 3600 + 30 * 60);
  // 23:30Z on the 20th is already the 21st locally.
  assert.equal(z.dayStr(utc(2026, 2, 20, 23, 30)), "2026-03-21");
  assert.equal(z.localDayKey(utc(2026, 2, 20, 23, 30)), z.localDayKey(utc(2026, 2, 21, 12)));
});

test("localZone emits a plain offset for a single segment and a CASE across a change", () => {
  const flat = localZone("Asia/Riyadh", utc(2026, 0, 1), utc(2026, 1, 1));
  assert.equal(flat.sqlLocalDate("s.started_at"), "DATE(FROM_UNIXTIME(s.started_at + 10800))");
  const dst = localZone("Europe/Berlin", utc(2026, 2, 1), utc(2026, 3, 30));
  assert.equal(
    dst.sqlLocalDate("s.started_at"),
    `DATE(FROM_UNIXTIME(s.started_at + CASE WHEN s.started_at >= ${utc(2026, 2, 29, 1)} THEN 7200 ELSE 3600 END))`
  );
});

test("localZone refuses a column expression it did not expect", () => {
  const z = localZone("Asia/Riyadh", utc(2026, 0, 1), utc(2026, 1, 1));
  assert.throws(() => z.sqlLocalDate("s.started_at; DROP TABLE x"));
});

test("tzSegments stays bounded for an absurd range", () => {
  const t0 = Date.now();
  tzSegments("Europe/Berlin", 0, utc(2026, 8, 1));
  assert.ok(Date.now() - t0 < 2000, "should not walk decades day by day without a cap");
});

test("localDate returns the local calendar date", () => {
  // 22:30Z on the 24th is already the 25th in Riyadh (UTC+3).
  assert.deepEqual(localDate("Asia/Riyadh", utc(2026, 8, 24, 22, 30)), { y: 2026, m: 9, d: 25 });
  assert.deepEqual(localDate("UTC", utc(2026, 8, 24, 22, 30)), { y: 2026, m: 9, d: 24 });
});

test("wallToUtc converts a local wall-clock time, DST-aware", () => {
  assert.equal(wallToUtc("Asia/Riyadh", { y: 2026, m: 9, d: 24 }, "13:00"), utc(2026, 8, 24, 10));
  // Berlin is UTC+1 in winter and UTC+2 in summer.
  assert.equal(wallToUtc("Europe/Berlin", { y: 2026, m: 3, d: 20 }, "13:00"), utc(2026, 2, 20, 12));
  assert.equal(wallToUtc("Europe/Berlin", { y: 2026, m: 4, d: 10 }, "13:00"), utc(2026, 3, 10, 11));
});

test("fixedWindows yields one window per local date the range touches", () => {
  // 09:00 local on the 24th to 17:00 local on the 25th, Riyadh.
  const w = fixedWindows("Asia/Riyadh", utc(2026, 8, 24, 6), utc(2026, 8, 25, 14), "13:00", "14:00");
  assert.deepEqual(w, [
    [utc(2026, 8, 24, 10), utc(2026, 8, 24, 11)],
    [utc(2026, 8, 25, 10), utc(2026, 8, 25, 11)],
  ]);
  assert.equal(fixedWindows("Asia/Riyadh", utc(2026, 8, 24, 6), utc(2026, 8, 24, 14), "13:00", "14:00").length, 1);
});

test("fixedWindows follows DST across a change", () => {
  const w = fixedWindows("Europe/Berlin", utc(2026, 2, 28, 9), utc(2026, 2, 29, 15), "13:00", "14:00");
  assert.deepEqual(w, [
    [utc(2026, 2, 28, 12), utc(2026, 2, 28, 13)], // CET
    [utc(2026, 2, 29, 11), utc(2026, 2, 29, 12)], // CEST from the 29th
  ]);
});

test("localDayBounds gives the UTC bounds of the local day containing an instant", () => {
  // Riyadh (UTC+3): 22:30Z on the 24th is already the 25th locally.
  assert.deepEqual(localDayBounds("Asia/Riyadh", utc(2026, 8, 24, 22, 30)),
    [utc(2026, 8, 24, 21), utc(2026, 8, 25, 21)]);
  // The day's first second belongs to it; its last second too; the next midnight does not.
  assert.deepEqual(localDayBounds("Asia/Riyadh", utc(2026, 8, 24, 21)), [utc(2026, 8, 24, 21), utc(2026, 8, 25, 21)]);
  assert.deepEqual(localDayBounds("Asia/Riyadh", utc(2026, 8, 25, 20, 59, 59)), [utc(2026, 8, 24, 21), utc(2026, 8, 25, 21)]);
  assert.deepEqual(localDayBounds("Asia/Riyadh", utc(2026, 8, 25, 21)), [utc(2026, 8, 25, 21), utc(2026, 8, 26, 21)]);
});

test("localDayBounds: a Berlin spring-forward day is 23 hours, a fall-back day 25", () => {
  const [s1, e1] = localDayBounds("Europe/Berlin", utc(2026, 2, 29, 12));
  assert.deepEqual([s1, e1], [utc(2026, 2, 28, 23), utc(2026, 2, 29, 22)]); // CET midnight → CEST midnight
  assert.equal(e1 - s1, 23 * 3600);
  const [s2, e2] = localDayBounds("Europe/Berlin", utc(2026, 9, 25, 12));
  assert.deepEqual([s2, e2], [utc(2026, 9, 24, 22), utc(2026, 9, 25, 23)]);
  assert.equal(e2 - s2, 25 * 3600);
});

test("localDayBounds starts the day at the change where midnight itself is skipped", () => {
  // Chile springs forward at 00:00 → 01:00 on 2026-09-06: that day starts at 01:00 local
  // (-03), i.e. 04:00Z, and the previous day ends there too.
  const [s, e] = localDayBounds("America/Santiago", utc(2026, 8, 6, 18));
  assert.equal(s, utc(2026, 8, 6, 4));
  assert.equal(e, utc(2026, 8, 7, 3));
  assert.equal(localDayBounds("America/Santiago", utc(2026, 8, 6, 3, 59, 59))[1], s);
});
