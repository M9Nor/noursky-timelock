import { describe, it, expect } from "vitest";
import { formatDuration, formatHours, serverOffset, formatClock, formatLateness, formatStamp } from "./time.js";

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

  it("returns a dash for a missing timestamp", () => {
    expect(formatStamp(null, "UTC")).toBe("—");
  });
});
