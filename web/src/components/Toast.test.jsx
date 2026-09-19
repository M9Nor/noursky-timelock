import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./ToastContext.jsx";

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast("تم الحفظ")}>go</button>;
}

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("shows a message then hides it", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    act(() => { screen.getByText("go").click(); });
    expect(screen.getByText("تم الحفظ")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText("تم الحفظ")).not.toBeInTheDocument();
  });
});
