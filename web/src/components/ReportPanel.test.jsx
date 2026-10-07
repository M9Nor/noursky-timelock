import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import { I18nProvider } from "../i18n.jsx";
import ReportPanel from "./ReportPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

function makeApi({ work_start = "09:00", employees, sessions = [], timezone = "Asia/Riyadh" } = {}) {
  const defaultEmployees = [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0, late_days: 0 }];
  return {
    get: vi.fn(async (p) => p.startsWith("/admin/report")
      ? { from: 0, to: 1, timezone, daily_target_hours: 8, work_start,
          employees: employees ?? defaultEmployees }
      : { sessions, timezone, work_start }),
    download: vi.fn(async () => {}),
  };
}

describe("ReportPanel", () => {
  it("re-reads the report every minute and when the page becomes visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = makeApi();
      wrap(<ReportPanel api={api} />);
      const reads = () => api.get.mock.calls.filter(([p]) => p.startsWith("/admin/report")).length;
      await waitFor(() => expect(reads()).toBe(1));
      await act(async () => { vi.advanceTimersByTime(60000); });
      await waitFor(() => expect(reads()).toBe(2));
      await act(async () => { vi.advanceTimersByTime(5000); document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(reads()).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("shows the late_days count when work_start is set", async () => {
    const api = makeApi({
      work_start: "09:00",
      employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 2, auto_closed: 0, late_days: 4 }],
    });
    wrap(<ReportPanel api={api} />);
    expect(await screen.findByText("أيام التأخير")).toBeInTheDocument();
    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("shows — for late_days when work_start is null", async () => {
    const api = makeApi({
      work_start: null,
      employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 2, auto_closed: 0, late_days: 4 }],
    });
    wrap(<ReportPanel api={api} />);
    expect(await screen.findByText("أيام التأخير")).toBeInTheDocument();
    expect(await screen.findByText("—")).toBeInTheDocument();
    expect(screen.queryByText("4")).not.toBeInTheDocument();
  });
  it("marks the late session inside the employee's session detail", async () => {
    const start = Date.UTC(2026, 8, 24, 6, 31) / 1000; // 09:31 in Asia/Riyadh
    const api = makeApi({
      sessions: [
        { id: 1, user_id: "a", started_at: start, ended_at: start + 3600, closed_by: null, late_by_sec: 31 * 60 },
        { id: 2, user_id: "a", started_at: start + 7200, ended_at: null, closed_by: null, late_by_sec: null },
      ],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("متأخر 31 د")).toBeInTheDocument();
    // Only the first session of the day is flagged, so exactly one cell carries it.
    expect(screen.getAllByText("متأخر 31 د")).toHaveLength(1);
  });

  it("renders detail timestamps in the location timezone, not the browser one", async () => {
    // 21:30Z is 17:30 on the 24th in New York — far from any Gulf/Turkey device clock.
    const start = Date.UTC(2026, 8, 24, 21, 30) / 1000;
    const api = makeApi({
      timezone: "America/New_York",
      sessions: [{ id: 1, user_id: "a", started_at: start, ended_at: null, closed_by: null, late_by_sec: null }],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("24/09/2026, 17:30")).toBeInTheDocument();
  });

  it("leaves the lateness column empty when work_start is not configured", async () => {
    const start = Date.UTC(2026, 8, 24, 6, 31) / 1000;
    const api = makeApi({
      work_start: null,
      sessions: [{ id: 1, user_id: "a", started_at: start, ended_at: null, closed_by: null, late_by_sec: null }],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("مفتوحة")).toBeInTheDocument();
    expect(screen.queryByText(/متأخر/)).not.toBeInTheDocument();
  });

  it("shows each session's break and note in the detail", async () => {
    const start = Date.UTC(2026, 8, 24, 6, 0) / 1000;
    const api = makeApi({
      sessions: [{ id: 1, user_id: "a", started_at: start, ended_at: start + 8 * 3600, closed_by: "user",
                   late_by_sec: null, break_sec: 30 * 60, note: "أنهيت عرض السعر" }],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("30 د")).toBeInTheDocument();
    expect(screen.getByText("أنهيت عرض السعر")).toBeInTheDocument();
    expect(screen.getByText("الملاحظة")).toBeInTheDocument();
  });

  it("shows each session's activity count and longest idle stretch", async () => {
    const session = { started_at: 1000, ended_at: 4600, break_sec: 0, closed_by: "user", note: null, late_by_sec: null };
    const api = makeApi({
      sessions: [
        { ...session, id: "s1", activity_count: 4, longest_idle_sec: 65 * 60 },
        { ...session, id: "s2", activity_count: null, longest_idle_sec: null },
      ],
    });
    wrap(<ReportPanel api={api} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByRole("columnheader", { name: "النشاط" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "أطول خمول" })).toBeInTheDocument();
    expect(screen.getByText("1 س 5 د")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
  it("shows English column headers inside an English provider", async () => {
    render(<I18nProvider locale="en"><ToastProvider><ReportPanel api={makeApi()} /></ToastProvider></I18nProvider>);
    expect(await screen.findByRole("columnheader", { name: "Late days" })).toBeInTheDocument();
  });

  it("names who closed each session, in the interface language", async () => {
    const base = { started_at: 1000, ended_at: 4600, break_sec: 0, note: null, late_by_sec: null };
    const sessions = [
      { ...base, id: "s1", closed_by: "user" }, { ...base, id: "s2", closed_by: "auto" },
      { ...base, id: "s3", closed_by: "admin" }, { ...base, id: "s4", closed_by: "other" },
    ];
    const { unmount } = wrap(<ReportPanel api={makeApi({ sessions })} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("الموظف")).toBeInTheDocument();
    expect(screen.getByText("تلقائي")).toBeInTheDocument();
    expect(screen.getByText("المدير")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
    unmount();
    render(<I18nProvider locale="en"><ToastProvider><ReportPanel api={makeApi({ sessions })} /></ToastProvider></I18nProvider>);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("Employee")).toBeInTheDocument();
    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(screen.getByText("Manager")).toBeInTheDocument();
  });

  it("labels a session that ended with the manager's approval", async () => {
    const sessions = [{ id: "s1", started_at: 1000, ended_at: 4600, break_sec: 0, note: "موعد", late_by_sec: null, closed_by: "approved" }];
    wrap(<ReportPanel api={makeApi({ sessions })} />);
    fireEvent.click(await screen.findByText("أحمد"));
    expect(await screen.findByText("بموافقة المدير")).toBeInTheDocument();
  });
});
