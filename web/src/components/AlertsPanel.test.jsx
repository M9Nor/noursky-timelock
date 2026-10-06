import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import { I18nProvider } from "../i18n.jsx";
import AlertsPanel from "./AlertsPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);
const at = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 09:05 in Dubai

describe("AlertsPanel", () => {
  it("re-reads the alerts every 30 seconds and when the page becomes visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = { get: vi.fn(async () => ({ alerts: [], timezone: "Asia/Dubai" })), post: vi.fn() };
      wrap(<AlertsPanel api={api} />);
      const open = () => api.get.mock.calls.filter(([p]) => p === "/admin/alerts?status=open").length;
      await waitFor(() => expect(open()).toBe(1));
      await act(async () => { vi.advanceTimersByTime(30000); });
      await waitFor(() => expect(open()).toBe(2));
      await act(async () => { vi.advanceTimersByTime(5000); document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(open()).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders nothing without open alerts", async () => {
    const api = { get: vi.fn(async () => ({ alerts: [], timezone: "Asia/Dubai" })), post: vi.fn() };
    const { container } = wrap(<AlertsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/admin/alerts?status=open"));
    expect(container.querySelector(".alerts")).toBeNull();
  });

  it("lists an open alert with the time in the location's zone and the employee's note", async () => {
    const api = {
      get: vi.fn(async () => ({
        alerts: [{ id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: at, employee_note: "كنت عم رد من الموبايل" }],
        timezone: "Asia/Dubai",
      })),
      post: vi.fn(),
    };
    wrap(<AlertsPanel api={api} />);
    expect(await screen.findByText("تنبيهات النشاط")).toBeInTheDocument();
    expect(screen.getByText("سارة")).toBeInTheDocument();
    expect(screen.getByText("عم يشتغل بدون دوام من 09:05")).toBeInTheDocument();
    expect(screen.getByText("كنت عم رد من الموبايل")).toBeInTheDocument();
  });

  it("dismisses an alert and removes it", async () => {
    const api = {
      get: vi.fn(async () => ({ alerts: [{ id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" })),
      post: vi.fn(async () => ({ ok: true })),
    };
    wrap(<AlertsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "تجاهل" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/alerts/a1/dismiss"));
    await waitFor(() => expect(screen.queryByText("سارة")).not.toBeInTheDocument());
  });
  describe("employee notes on resolved alerts", () => {
    const now = at + 100000;
    const openAlert = { id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: at };
    const resolved = (over) => ({
      id: "r1", user_id: "u2", name: "خالد", kind: "working_not_clocked_in", from_at: at, status: "resolved",
      resolution: "clocked_in", employee_note: "رح ابلّش هلّق", resolved_at: now - 3600, ...over,
    });
    const apiWith = ({ open = [openAlert], resolvedList = [], resolvedFails = false } = {}) => ({
      get: vi.fn(async (path) => {
        if (path === "/admin/alerts?status=open") return { alerts: open, timezone: "Asia/Dubai", server_time: now };
        if (path === "/admin/alerts?status=resolved") {
          if (resolvedFails) throw new Error("boom");
          return { alerts: resolvedList, timezone: "Asia/Dubai", server_time: now };
        }
        throw new Error(`unexpected ${path}`);
      }),
      post: vi.fn(),
    });

    it("shows a recently resolved alert's note read-only", async () => {
      wrap(<AlertsPanel api={apiWith({ resolvedList: [resolved()] })} />);
      expect(await screen.findByText("ملاحظات الموظفين")).toBeInTheDocument();
      expect(screen.getByText("خالد")).toBeInTheDocument();
      expect(screen.getByText("كان عم يشتغل بدون دوام من 09:05 · بلّش الدوام")).toBeInTheDocument();
      expect(screen.getByText("رح ابلّش هلّق")).toBeInTheDocument();
      // only the open alert (سارة) has a dismiss button
      expect(screen.getAllByRole("button", { name: "تجاهل" })).toHaveLength(1);
    });

    it("hides resolved alerts without a note or older than 24 hours", async () => {
      const list = [
        resolved({ id: "r1", name: "بدون ملاحظة", employee_note: null }),
        resolved({ id: "r2", name: "قديم", resolved_at: now - 25 * 3600 }),
      ];
      wrap(<AlertsPanel api={apiWith({ resolvedList: list })} />);
      expect(await screen.findByText("سارة")).toBeInTheDocument();
      expect(screen.queryByText("ملاحظات الموظفين")).not.toBeInTheDocument();
      expect(screen.queryByText("بدون ملاحظة")).not.toBeInTheDocument();
      expect(screen.queryByText("قديم")).not.toBeInTheDocument();
    });

    it("still shows open alerts when the resolved request fails", async () => {
      wrap(<AlertsPanel api={apiWith({ resolvedFails: true })} />);
      expect(await screen.findByText("سارة")).toBeInTheDocument();
      expect(screen.queryByText("ملاحظات الموظفين")).not.toBeInTheDocument();
    });

    it("renders for notes alone, without a count badge", async () => {
      const { container } = wrap(<AlertsPanel api={apiWith({ open: [], resolvedList: [resolved()] })} />);
      expect(await screen.findByText("ملاحظات الموظفين")).toBeInTheDocument();
      expect(screen.getByText("رح ابلّش هلّق")).toBeInTheDocument();
      expect(container.querySelector(".count")).toBeNull();
    });
  });

  it("shows an ongoing idle alert with its minutes, and an ended one with its span", async () => {
    const now = Date.UTC(2026, 9, 5, 8, 0) / 1000;            // 12:00 Dubai
    const from = now - 25 * 60;                                 // 11:35
    const api = {
      get: vi.fn(async (p) => (p.includes("status=open")
        ? { alerts: [
            { id: "i1", user_id: "u1", name: "سارة", kind: "idle", from_at: from, to_at: null },
            { id: "i2", user_id: "u2", name: "أحمد", kind: "idle", from_at: now - 3600, to_at: now - 3600 + 45 * 60 },
          ], timezone: "Asia/Dubai", server_time: now }
        : { alerts: [], server_time: now })),
      post: vi.fn(),
    };
    wrap(<AlertsPanel api={api} />);
    expect(await screen.findByText("بدون نشاط من 11:35 · 25 د")).toBeInTheDocument();
    expect(screen.getByText("بدون نشاط من 11:00 لـ 11:45 (45 د)")).toBeInTheDocument();
  });

  it("lists only not-clocked-in alerts under the employees' notes", async () => {
    const now = Date.UTC(2026, 9, 5, 8, 0) / 1000;
    const api = {
      get: vi.fn(async (p) => (p.includes("status=open")
        ? { alerts: [], timezone: "UTC", server_time: now }
        : { alerts: [
            { id: "r1", user_id: "u1", name: "سارة", kind: "idle", from_at: now - 600, to_at: now - 590, resolved_at: now - 590, employee_note: "ملاحظة خمول" },
          ], server_time: now })),
      post: vi.fn(),
    };
    const { container } = wrap(<AlertsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("ملاحظة خمول")).not.toBeInTheDocument();
    expect(container.querySelector(".alerts")).toBeNull();
  });

  it("marks the tab title while alerts are open", async () => {
    document.title = "الدوام";
    const api = {
      get: vi.fn(async () => ({ alerts: [{ id: "a1", user_id: "u1", name: "سارة", kind: "working_not_clocked_in", from_at: 1 }], timezone: "UTC", server_time: 2 })),
      post: vi.fn(),
    };
    wrap(<AlertsPanel api={api} />);
    await screen.findByText("سارة");
    expect(document.title).toBe("⚠️ الدوام");
  });
  it("words alerts in English inside an English provider", async () => {
    const idleFrom = Date.UTC(2026, 9, 5, 7, 35) / 1000; // 11:35 in Dubai
    const api = {
      get: vi.fn(async () => ({
        alerts: [
          { id: "a1", user_id: "u1", name: "Sara", kind: "working_not_clocked_in", from_at: at },
          { id: "a2", user_id: "u2", name: "Omar", kind: "idle", from_at: idleFrom, to_at: null },
        ],
        timezone: "Asia/Dubai",
        server_time: idleFrom + 25 * 60,
      })),
      post: vi.fn(),
    };
    render(<I18nProvider locale="en"><ToastProvider><AlertsPanel api={api} /></ToastProvider></I18nProvider>);
    expect(await screen.findByText("Working without clocking in since 09:05")).toBeInTheDocument();
    expect(screen.getByText("No activity since 11:35 · 25 min")).toBeInTheDocument();
  });
});
