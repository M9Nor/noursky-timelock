import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import KpiRow from "./KpiRow.jsx";

describe("KpiRow", () => {
  it("counts working vs total from live payload", () => {
    render(<KpiRow live={{ server_time: 1, employees: [
      { user_id: "a", name: "أحمد", session_id: "s1", started_at: 0 },
      { user_id: "b", name: "سارة", session_id: null, started_at: null },
    ] }} />);
    expect(screen.getByText("داخل الدوام الآن").closest(".kpi").textContent).toContain("1");
    expect(screen.getByText("إجمالي الموظفين").closest(".kpi").textContent).toContain("2");
  });
});
