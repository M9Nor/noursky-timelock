import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import EarlyLeavePanel from "./EarlyLeavePanel.jsx";

const at = Date.UTC(2026, 9, 7, 12, 0) / 1000;
const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);
const pendingReq = { id: "r1", user_id: "u1", name: "سارة", reason: "موعد", requested_at: at, status: "pending" };

function makeApi({ pending = [pendingReq], all = [] } = {}) {
  return {
    get: vi.fn(async (p) => (p.startsWith("/admin/early-leave?status=pending")
      ? { requests: pending, timezone: "UTC", server_time: at }
      : { requests: all, timezone: "UTC", server_time: at })),
    post: vi.fn(async () => ({ ok: true })),
  };
}

describe("EarlyLeavePanel", () => {
  it("renders nothing with no pending request and no history", async () => {
    const api = makeApi({ pending: [], all: [] });
    const { container } = wrap(<EarlyLeavePanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector(".early-leave")).toBeNull();
  });

  it("lists a pending request and approves it", async () => {
    const api = makeApi();
    wrap(<EarlyLeavePanel api={api} />);
    expect(await screen.findByText("سارة")).toBeInTheDocument();
    expect(screen.getByText("موعد")).toBeInTheDocument();
    expect(screen.getByText("طلب الساعة 12:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "موافقة" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/early-leave/r1/approve"));
  });

  it("asks the other panels to refresh after a decision", async () => {
    const seen = vi.fn();
    window.addEventListener("timeclock:refresh", seen);
    try {
      wrap(<EarlyLeavePanel api={makeApi()} />);
      fireEvent.click(await screen.findByRole("button", { name: "موافقة" }));
      await waitFor(() => expect(seen).toHaveBeenCalled());
    } finally {
      window.removeEventListener("timeclock:refresh", seen);
    }
  });

  it("rejects with an optional note", async () => {
    const api = makeApi();
    wrap(<EarlyLeavePanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "رفض" }));
    fireEvent.change(screen.getByLabelText("ملاحظة للموظف (اختيارية)"), { target: { value: "بعد الطلبية" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الرفض" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/admin/early-leave/r1/reject", { note: "بعد الطلبية" }));
  });

  it("shows the history with every field and filters by name", async () => {
    const api = makeApi({ pending: [], all: [
      { ...pendingReq, status: "approved", decided_at: at + 300, decided_by_name: "المدير" },
      { ...pendingReq, id: "r2", user_id: "u2", name: "أحمد", reason: "ظرف", status: "rejected", decided_at: at + 60, decided_by_name: "المدير", manager_note: "لا" },
    ] });
    wrap(<EarlyLeavePanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "السجل" }));
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(screen.getByText("مرفوض")).toBeInTheDocument();
    expect(screen.getByText("لا")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("بحث عن موظف"), { target: { value: "سارة" } });
    expect(screen.queryByText("أحمد")).toBeNull();
    expect(screen.getByText("موافَق")).toBeInTheDocument();
  });

  it("marks the tab title while a request is pending", async () => {
    document.title = "TimeClock";
    wrap(<EarlyLeavePanel api={makeApi()} />);
    await screen.findByText("سارة");
    expect(document.title).toBe("⚠️ TimeClock");
  });
});
