import { describe, it, expect } from "vitest";
import { formatDuration, formatHours, serverOffset, formatClock } from "./time.js";

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
