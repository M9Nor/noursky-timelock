import { describe, it, expect } from "vitest";
import { formatDuration, formatHours, serverOffset } from "./time.js";

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
