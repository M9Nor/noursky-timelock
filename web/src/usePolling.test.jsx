import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { usePolling, REFRESH_EVENT } from "./usePolling.js";

function Probe({ fn, ms }) {
  usePolling(fn, ms);
  return null;
}

function setVisibility(state) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("usePolling", () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  it("calls the function every interval, not at mount", () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {});
    render(<Probe fn={fn} ms={30000} />);
    expect(fn).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(30000); });
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("calls the function when the page becomes visible again, not when it is hidden", () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {});
    render(<Probe fn={fn} ms={30000} />);
    act(() => setVisibility("hidden"));
    expect(fn).not.toHaveBeenCalled();
    act(() => setVisibility("visible"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls the function when the window gets focus, once for focus and visibility together", () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {});
    render(<Probe fn={fn} ms={30000} />);
    act(() => { setVisibility("visible"); window.dispatchEvent(new Event("focus")); });
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(5000); window.dispatchEvent(new Event("focus")); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses the latest function and swallows its errors", () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => { throw new Error("offline"); });
    const { rerender } = render(<Probe fn={first} ms={30000} />);
    rerender(<Probe fn={second} ms={30000} />);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("re-runs at once on the app-wide refresh event, even right after another run", () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {});
    render(<Probe fn={fn} ms={30000} />);
    act(() => { setVisibility("visible"); });
    act(() => { window.dispatchEvent(new Event(REFRESH_EVENT)); });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops after unmount", () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {});
    const { unmount } = render(<Probe fn={fn} ms={30000} />);
    unmount();
    act(() => { vi.advanceTimersByTime(60000); setVisibility("visible"); window.dispatchEvent(new Event("focus")); });
    expect(fn).not.toHaveBeenCalled();
  });
});
