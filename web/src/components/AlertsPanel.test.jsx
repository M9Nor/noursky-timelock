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
});
