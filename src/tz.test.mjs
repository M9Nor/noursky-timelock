import { test } from "node:test";
import assert from "node:assert/strict";
import { tzOffsetSec, tzSegments, localZone } from "./tz.js";

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
