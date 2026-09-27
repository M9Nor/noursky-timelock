import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import EmployeeScreen from "./EmployeeScreen.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

const DEFAULT_SETTINGS = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null, breaks_enabled: false, note_on_stop: "off" };

function makeApi(status, settings = DEFAULT_SETTINGS, settingsError = null, post = vi.fn(async () => ({}))) {
  const get = vi.fn((path) => {
    if (path && path.startsWith("/me/settings")) {
      if (settingsError) return Promise.reject(settingsError);
      return Promise.resolve(settings);
    }
    if (path && path.startsWith("/me/sessions")) {
      return Promise.resolve({ sessions: [] });
    }
    return Promise.resolve(status);
  });
  return { get, post };
}

const nowSec = () => Math.floor(Date.now() / 1000);

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

  it("degrades to default 8-hour target when settings fetch fails, without showing error", async () => {
    const api = makeApi(
      { open_session: null, worked_sec: 0, server_time: 1000 },
      null,
      new Error("NETWORK_ERROR")
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    // Settings fetch fails, but /me/status succeeds, so button should appear
    expect(await screen.findByRole("button", { name: /بدء الدوام/ })).toBeInTheDocument();
    // No error banner should be shown (settings failure is silent)
    expect(screen.queryByText(/حدث خطأ، حاول مرة أخرى/)).not.toBeInTheDocument();
    // Should show default 8.00 target hours (not custom 6.00)
    const elements = await screen.findAllByText("8.00");
    expect(elements.length).toBeGreaterThan(0);
  });

  it("does not count a session that was already running on load twice", async () => {
    const t = nowSec();
    // worked_sec is exact at server_time and already includes the open hour.
    const api = makeApi({ open_session: { id: "s1", started_at: t - 3600, break_sec: 0 }, open_break: null, worked_sec: 3600, server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByRole("button", { name: /إنهاء الدوام/ });
    expect(screen.getByText("مجموع اليوم").querySelector("strong").textContent).toBe("1.00");
  });

  it("freezes the clock during a break and shows the break state", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 3600, break_sec: 600 }, open_break: { id: "b1", started_at: t - 600 }, worked_sec: 3000, server_time: t },
      { ...DEFAULT_SETTINGS, breaks_enabled: true }
    );
    const { container } = wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("في استراحة")).toBeInTheDocument();
    expect(container.querySelector(".timer").textContent).toBe("0:50:00");
    expect(screen.getByRole("button", { name: /إنهاء الاستراحة/ })).toBeInTheDocument();
  });

  it("hides the break button when breaks are disabled", async () => {
    const t = nowSec();
    const api = makeApi({ open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByRole("button", { name: /إنهاء الدوام/ });
    expect(screen.queryByRole("button", { name: /استراحة/ })).not.toBeInTheDocument();
  });

  it("starts a break", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, breaks_enabled: true }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /^استراحة$/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/break/start"));
  });

  it("stops directly when the note policy is off", async () => {
    const t = nowSec();
    const api = makeApi({ open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /إنهاء الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/stop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for a required note and sends it with the stop", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, note_on_stop: "required" }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const stop = await screen.findByRole("button", { name: /إنهاء الدوام/ });
    // Let the /me/settings effect land: clicking before it would still see policy "off".
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/settings"));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(stop);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("ملاحظة"), { target: { value: "أنهيت العرض" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/stop", { note: "أنهيت العرض" }));
  });

  it("shows a generic error inside the note dialog when the stop fails for another reason", async () => {
    const t = nowSec();
    const post = vi.fn(async (path) => {
      if (path === "/session/stop") throw Object.assign(new Error("SOME_ERROR"), { code: "SOME_ERROR" });
      return {};
    });
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, note_on_stop: "required" }, null, post
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const stop = await screen.findByRole("button", { name: /إنهاء الدوام/ });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/settings"));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(stop);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ملاحظة"), { target: { value: "أنهيت العرض" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    // The error must show up INSIDE the dialog (which stays open), not behind it.
    const dialog = await screen.findByRole("dialog");
    expect(await screen.findByText("حدث خطأ، حاول مرة أخرى")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });

  it("closes the note dialog and refetches status when the stop fails with NO_OPEN_SESSION", async () => {
    const t = nowSec();
    const post = vi.fn(async (path) => {
      if (path === "/session/stop") throw Object.assign(new Error("NO_OPEN_SESSION"), { code: "NO_OPEN_SESSION" });
      return {};
    });
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, note_on_stop: "required" }, null, post
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const stop = await screen.findByRole("button", { name: /إنهاء الدوام/ });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/settings"));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(stop);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ملاحظة"), { target: { value: "أنهيت العرض" } });
    const getCallsBefore = api.get.mock.calls.filter((c) => c[0] === "/me/status").length;
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => {
      const callsAfter = api.get.mock.calls.filter((c) => c[0] === "/me/status").length;
      expect(callsAfter).toBeGreaterThan(getCallsBefore);
    });
  });

  it("shows a specific message and refreshes when a break action fails with BREAKS_DISABLED", async () => {
    const t = nowSec();
    const post = vi.fn(async (path) => {
      if (path === "/session/break/start") throw Object.assign(new Error("BREAKS_DISABLED"), { code: "BREAKS_DISABLED" });
      return {};
    });
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      { ...DEFAULT_SETTINGS, breaks_enabled: true },
      null, post
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const breakBtn = await screen.findByRole("button", { name: /^استراحة$/ });
    const getCallsBefore = api.get.mock.calls.filter((c) => c[0] === "/me/status").length;
    fireEvent.click(breakBtn);
    expect(await screen.findByText("الاستراحات غير مفعّلة")).toBeInTheDocument();
    await waitFor(() => {
      const callsAfter = api.get.mock.calls.filter((c) => c[0] === "/me/status").length;
      expect(callsAfter).toBeGreaterThan(getCallsBefore);
    });
  });

  it("opens the note dialog when the server says a note is required", async () => {
    const t = nowSec();
    const post = vi.fn(async (path) => {
      if (path === "/session/stop") throw Object.assign(new Error("NOTE_REQUIRED"), { code: "NOTE_REQUIRED" });
      return {};
    });
    // Settings fail to load, so the screen believes the policy is off.
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t },
      null, new Error("NETWORK"), post
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /إنهاء الدوام/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("حدث خطأ، حاول مرة أخرى")).not.toBeInTheDocument();
  });
});
