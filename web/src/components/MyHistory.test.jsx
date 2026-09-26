import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
