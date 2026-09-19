import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ReportPanel from "./ReportPanel.jsx";

function makeApi(overrides = {}) {
  return {
    get: vi.fn(async (p) => {
      if (p.startsWith("/admin/report")) return {
        from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8,
        employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 }],
      };
      return { sessions: [] };
    }),
    download: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ReportPanel", () => {
  it("renders per-employee worked hours from the report", async () => {
    const api = makeApi();
    render(<ReportPanel api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("1.00")).toBeInTheDocument();
  });

  it("exports CSV via the authenticated api client on click", async () => {
    const api = makeApi();
    render(<ReportPanel api={api} />);
    const btn = await screen.findByText("تصدير CSV");
    fireEvent.click(btn);
    await vi.waitFor(() => expect(api.download).toHaveBeenCalledTimes(1));
    const [path, filename] = api.download.mock.calls[0];
    expect(path).toMatch(/^\/admin\/export\.csv\?from=\d+&to=\d+$/);
    expect(filename).toMatch(/^timeclock-\d+-\d+\.csv$/);
  });

  it("shows an error message when the export fails", async () => {
    const api = makeApi({ download: vi.fn(async () => { throw new Error("boom"); }) });
    render(<ReportPanel api={api} />);
    const btn = await screen.findByText("تصدير CSV");
    fireEvent.click(btn);
    expect(await screen.findByText("حدث خطأ، حاول مرة أخرى")).toBeInTheDocument();
  });
});
