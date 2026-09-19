import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import ReportPanel from "./ReportPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

function makeApi() {
  return {
    get: vi.fn(async (p) => p.startsWith("/admin/report")
      ? { from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8,
          employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 }] }
      : { sessions: [] }),
    download: vi.fn(async () => {}),
  };
}

describe("ReportPanel", () => {
  it("renders per-employee hours", async () => {
    wrap(<ReportPanel api={makeApi()} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("1.00")).toBeInTheDocument();
  });

  it("exports CSV through the authenticated client", async () => {
    const api = makeApi();
    wrap(<ReportPanel api={api} />);
    await screen.findByText("أحمد");
    fireEvent.click(screen.getByRole("button", { name: /تصدير CSV/ }));
    await waitFor(() => expect(api.download).toHaveBeenCalled());
    const [path, filename] = api.download.mock.calls[0];
    expect(path).toMatch(/^\/admin\/export\.csv\?from=\d+&to=\d+$/);
    expect(filename).toMatch(/\.csv$/);
  });

  it("filters by search text", async () => {
    const api = {
      get: vi.fn(async (p) => p.startsWith("/admin/report")
        ? { from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8, employees: [
            { user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 },
            { user_id: "b", name: "سارة", worked_sec: 7200, sessions_count: 1, days_present: 1, auto_closed: 0 },
          ] }
        : { sessions: [] }),
      download: vi.fn(),
    };
    wrap(<ReportPanel api={api} />);
    await screen.findByText("أحمد");
    fireEvent.change(screen.getByPlaceholderText(/بحث/), { target: { value: "سارة" } });
    expect(screen.queryByText("أحمد")).not.toBeInTheDocument();
    expect(screen.getByText("سارة")).toBeInTheDocument();
  });
});
