import { describe, it, expect } from "vitest";
import { formatDuration, formatHours, serverOffset, formatClock, formatLateness, formatStamp, formatBreak, liveTotals, formatTime, formatIdle } from "./time.js";

describe("time helpers", () => {
  it("formats duration as H:MM:SS with Western digits", () => {
    expect(formatDuration(0)).toBe("0:00:00");
    expect(formatDuration(65)).toBe("0:01:05");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(36000)).toBe("10:00:00");
  });
  it("clamps negative durations to zero", () => {
    expect(formatDuration(-5)).toBe("0:00:00");
  });
  it("formats hours to two decimals", () => {
    expect(formatHours(3600)).toBe("1.00");
    expect(formatHours(1800)).toBe("0.50");
  });
  it("serverOffset returns seconds difference", () => {
    const off = serverOffset(Math.floor(Date.now() / 1000) + 100);
    expect(off).toBeGreaterThan(90);
    expect(off).toBeLessThan(110);
  });
});

describe("formatClock", () => {
  it("splits seconds into h / padded mm / padded ss", () => {
    expect(formatClock(0)).toEqual({ h: 0, mm: "00", ss: "00" });
    expect(formatClock(65)).toEqual({ h: 0, mm: "01", ss: "05" });
    expect(formatClock(3661)).toEqual({ h: 1, mm: "01", ss: "01" });
    expect(formatClock(36000)).toEqual({ h: 10, mm: "00", ss: "00" });
  });
  it("clamps negatives to zero", () => {
    expect(formatClock(-5)).toEqual({ h: 0, mm: "00", ss: "00" });
  });
});

describe("formatLateness", () => {
  it("rounds any lateness up to a whole minute so a few seconds still show", () => {
    expect(formatLateness(1)).toBe("متأخر 1 د");
    expect(formatLateness(59)).toBe("متأخر 1 د");
    expect(formatLateness(31 * 60)).toBe("متأخر 31 د");
  });

  it("splits an hour or more into hours and minutes", () => {
    expect(formatLateness(3600)).toBe("متأخر 1 س");
    expect(formatLateness(90 * 60)).toBe("متأخر 1 س 30 د");
    expect(formatLateness(125 * 60)).toBe("متأخر 2 س 5 د");
  });

  it("returns an empty string when there is no lateness", () => {
    expect(formatLateness(null)).toBe("");
    expect(formatLateness(0)).toBe("");
    expect(formatLateness(undefined)).toBe("");
  });
});

describe("formatStamp", () => {
  it("renders the timestamp in the given timezone, not the browser one", () => {
    // 2026-09-24T21:30:00Z is already the 25th in Asia/Riyadh (UTC+3).
    const ts = Date.UTC(2026, 8, 24, 21, 30) / 1000;
    expect(formatStamp(ts, "Asia/Riyadh")).toBe("25/09/2026, 00:30");
    expect(formatStamp(ts, "UTC")).toBe("24/09/2026, 21:30");
  });

  it("falls back to the browser timezone when the zone is unusable", () => {
    const ts = Date.UTC(2026, 8, 24, 21, 30) / 1000;
    expect(formatStamp(ts, "Not/AZone")).toMatch(/2026, \d{2}:\d{2}$/);
  });

  it("can drop the year for compact tables", () => {
    const ts = Date.UTC(2026, 8, 24, 21, 30) / 1000;
    expect(formatStamp(ts, "Asia/Riyadh", { year: false })).toBe("25/09, 00:30");
  });

  it("returns a dash for a missing timestamp", () => {
    expect(formatStamp(null, "UTC")).toBe("—");
  });
});

describe("formatBreak", () => {
  it("shows whole minutes, never 0 for a real break", () => {
    expect(formatBreak(20)).toBe("1 د");
    expect(formatBreak(15 * 60)).toBe("15 د");
    expect(formatBreak(90 * 60)).toBe("90 د");
  });
  it("is empty when there was no break", () => {
    expect(formatBreak(0)).toBe("");
    expect(formatBreak(null)).toBe("");
  });
});

describe("liveTotals", () => {
  const t = 1_000_000;
  const base = { open_session: { id: "s", started_at: t - 3600, break_sec: 0 }, open_break: null, worked_sec: 3600, server_time: t, fixed_break: null };

  it("adds only the seconds since server_time (no double count)", () => {
    expect(liveTotals(base, t + 60)).toMatchObject({ sessionSec: 3660, todaySec: 3660, onBreak: false, inFixed: false });
  });

  it("freezes during an employee break", () => {
    const s = { ...base, open_session: { ...base.open_session, break_sec: 600 }, open_break: { id: "b", started_at: t - 600 }, worked_sec: 3000 };
    expect(liveTotals(s, t + 900)).toMatchObject({ sessionSec: 3000, todaySec: 3000, onBreak: true });
  });

  it("pauses for the part of an unpaid fixed window after server_time", () => {
    const s = { ...base, fixed_break: { starts_at: t + 60, ends_at: t + 660, paid: false } };
    expect(liveTotals(s, t + 300)).toMatchObject({ todaySec: 3600 + 60, inFixed: true });
    expect(liveTotals(s, t + 900)).toMatchObject({ sessionSec: 3600 + 300, todaySec: 3600 + 300, inFixed: false });
  });

  it("keeps counting through a paid fixed window", () => {
    const s = { ...base, fixed_break: { starts_at: t + 60, ends_at: t + 660, paid: true } };
    expect(liveTotals(s, t + 300)).toMatchObject({ todaySec: 3900, inFixed: true });
  });

  it("is all zeros with no open session", () => {
    expect(liveTotals({ open_session: null, open_break: null, worked_sec: 120, server_time: t, fixed_break: null }, t + 50))
      .toMatchObject({ sessionSec: 0, todaySec: 120, inFixed: false });
  });
});

describe("formatTime", () => {
  it("shows the wall-clock time in the given zone", () => {
    const ts = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 05:05Z
    expect(formatTime(ts, "Asia/Dubai")).toBe("09:05");
    expect(formatTime(ts, "UTC")).toBe("05:05");
  });
  it("shows a dash without a timestamp", () => {
    expect(formatTime(null, "UTC")).toBe("—");
  });
});

describe("formatIdle", () => {
  it("formats minutes and hours, and a dash for no value", () => {
    expect(formatIdle(null)).toBe("—");
    expect(formatIdle(0)).toBe("0 د");
    expect(formatIdle(45 * 60 + 20)).toBe("45 د");
    expect(formatIdle(65 * 60)).toBe("1 س 5 د");
    expect(formatIdle(120 * 60)).toBe("2 س");
  });
});
