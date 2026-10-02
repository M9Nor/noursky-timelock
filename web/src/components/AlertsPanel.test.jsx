import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import AlertsPanel from "./AlertsPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);
const at = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 09:05 in Dubai

describe("AlertsPanel", () => {
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
});
