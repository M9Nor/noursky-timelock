import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import EmployeeScreen from "./EmployeeScreen.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

function makeApi(status, settings = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null }) {
  const get = vi.fn((path) => {
    if (path && path.startsWith("/me/settings")) {
      return Promise.resolve(settings);
    }
    return Promise.resolve(status);
  });
  return {
    get,
    post: vi.fn(async () => ({})),
  };
}

describe("EmployeeScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows start button when no open session", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: 1000 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /بدء الدوام/ })).toBeInTheDocument();
  });

  it("shows end button when a session is open", async () => {
    const started = Math.floor(Date.now() / 1000) - 60;
    const api = makeApi({ open_session: { id: "s1", started_at: started }, worked_sec: 60, server_time: started + 60 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /إنهاء الدوام/ })).toBeInTheDocument();
  });

  it("calls /session/start on click", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: 1000 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /بدء الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/start"));
  });

  it("greets the user by name", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: 1000 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText(/سارة/)).toBeInTheDocument();
  });

  it("uses the location's daily target, not a hardcoded 8", async () => {
    const api = makeApi(
      { open_session: null, worked_sec: 0, server_time: 1000 },
      { daily_target_hours: 6, timezone: "Asia/Riyadh", work_start: null }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    // Multiple elements with "6.00" appear (required + remaining), so use getAllByText
    const elements = await screen.findAllByText("6.00");
    expect(elements).not.toHaveLength(0);
  });
});
