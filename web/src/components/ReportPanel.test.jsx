import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ReportPanel from "./ReportPanel.jsx";

describe("ReportPanel", () => {
  it("renders per-employee worked hours from the report", async () => {
    const api = { get: vi.fn(async (p) => {
      if (p.startsWith("/admin/report")) return {
        from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8,
        employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 }],
      };
      return { sessions: [] };
    }) };
    render(<ReportPanel api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("1.00")).toBeInTheDocument();
  });
});
