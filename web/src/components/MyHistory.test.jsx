import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MyHistory from "./MyHistory.jsx";

describe("MyHistory", () => {
  it("lists the employee's recent sessions", async () => {
    const api = {
      get: vi.fn(async () => ({
        sessions: [
          { id: "a", started_at: 1758700000, ended_at: 1758728800, duration_sec: 28800, closed_by: "user" },
        ],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("8.00")).toBeInTheDocument();
  });

  it("reloads when its reload key changes", async () => {
    const api = { get: vi.fn(async () => ({ sessions: [] })) };
    const { rerender } = render(<MyHistory api={api} reloadKey={0} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    rerender(<MyHistory api={api} reloadKey={1} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("flags auto-closed sessions", async () => {
    const api = {
      get: vi.fn(async () => ({
        sessions: [
          { id: "b", started_at: 1758700000, ended_at: 1758743200, duration_sec: 43200, closed_by: "auto" },
        ],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("أُغلقت تلقائياً")).toBeInTheDocument();
  });

  it("shows an empty state when there are no sessions", async () => {
    const api = { get: vi.fn(async () => ({ sessions: [] })) };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("لا توجد جلسات في آخر 7 أيام.")).toBeInTheDocument();
  });
  it("renders times in the company timezone, not the device one", async () => {
    // 21:30Z is 17:30 on the 24th in New York — far from any Gulf/Turkey device clock.
    const start = Date.UTC(2026, 8, 24, 21, 30) / 1000;
    const api = {
      get: vi.fn(async () => ({
        timezone: "America/New_York",
        sessions: [{ id: "c", started_at: start, ended_at: null, duration_sec: null, closed_by: null }],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("24/09, 17:30")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/me/sessions?days=7");
  });

  it("shows worked hours without the breaks", async () => {
    const api = {
      get: vi.fn(async () => ({
        timezone: "Asia/Riyadh",
        sessions: [{ id: "d", started_at: 1758700000, ended_at: 1758728800, duration_sec: 28800, break_sec: 1800, closed_by: "user" }],
      })),
    };
    render(<MyHistory api={api} />);
    expect(await screen.findByText("7.50")).toBeInTheDocument();
  });
});
