import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import EmployeeScreen from "./EmployeeScreen.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

const DEFAULT_SETTINGS = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null, break_mode: "off", break_start: null, break_end: null, break_paid: false, note_on_stop: "off" };

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

// Answers /me/alerts with `alerts` (an Error rejects) and everything else like `api`.
function withAlerts(api, alerts) {
  const base = api.get;
  api.get = vi.fn((path) => (path && path.startsWith("/me/alerts")
    ? (alerts instanceof Error ? Promise.reject(alerts) : Promise.resolve(alerts))
    : base(path)));
  return api;
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe("EmployeeScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks an employee working without a session to start the day", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000; // 09:05 Dubai
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "Asia/Dubai" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("مبيّن إنك عم تشتغل من 09:05. بتبلّش الدوام؟")).toBeInTheDocument();
  });

  it("sends the employee's note on the alert", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000;
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.change(await screen.findByLabelText("ملاحظة للمدير"), { target: { value: "كنت عم رد من الموبايل" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الملاحظة" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/me/alerts/a1/note", { note: "كنت عم رد من الموبايل" }));
  });

  it("says so while activity monitoring is on", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: nowSec(), activity_monitoring: true });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("مراقبة النشاط مفعّلة")).toBeInTheDocument();
  });

  it("still works when the alerts request fails", async () => {
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }), new Error("down"));
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    // The alerts request ran and its rejection has been handled before we assert.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/alerts"));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/settings"));
    await act(async () => { await Promise.resolve(); });
    expect(await screen.findByRole("button", { name: /بدء الدوام/ })).toBeInTheDocument();
    expect(screen.queryByText("حدث خطأ، حاول مرة أخرى")).not.toBeInTheDocument();
  });

  it("starts the day from the banner's own button", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000;
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const banner = (await screen.findByText(/مبيّن إنك عم تشتغل/)).closest("section");
    expect(screen.getAllByRole("button", { name: /بدء الدوام/ })).toHaveLength(2);
    fireEvent.click(within(banner).getByRole("button", { name: /بدء الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/start"));
  });

  it("shows no banner while a session is open", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000;
    const started = nowSec() - 60;
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: started }, worked_sec: 60, server_time: started + 60 }),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /إنهاء الدوام/ })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/alerts"));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/مبيّن إنك عم تشتغل/)).not.toBeInTheDocument();
  });

  it("shows a too-long note error next to the note box", async () => {
    const at = Date.UTC(2026, 9, 5, 5, 5) / 1000;
    const post = vi.fn(async () => { throw { code: "NOTE_TOO_LONG" }; });
    const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }, DEFAULT_SETTINGS, null, post),
      { alerts: [{ id: "a1", kind: "working_not_clocked_in", from_at: at }], timezone: "UTC" });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const banner = (await screen.findByText(/مبيّن إنك عم تشتغل/)).closest("section");
    const send = within(banner).getByRole("button", { name: "إرسال الملاحظة" });
    expect(send).toBeDisabled();
    fireEvent.change(within(banner).getByLabelText("ملاحظة للمدير"), { target: { value: "ملاحظة" } });
    fireEvent.click(send);
    expect(await within(banner).findByText("الملاحظة طويلة جداً")).toBeInTheDocument();
    await waitFor(() => expect(send).not.toBeDisabled());
  });

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
      { ...DEFAULT_SETTINGS, break_mode: "flexible" }
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
      { ...DEFAULT_SETTINGS, break_mode: "flexible" }
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
      { ...DEFAULT_SETTINGS, break_mode: "flexible" },
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

  it("shows a fixed window as break time without a break button", async () => {
    const t = nowSec();
    const api = makeApi(
      { open_session: { id: "s1", started_at: t - 3600, break_sec: 300 }, open_break: null, worked_sec: 3300, server_time: t,
        fixed_break: { starts_at: t - 300, ends_at: t + 3300, paid: false } },
      { ...DEFAULT_SETTINGS, break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false }
    );
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText("وقت الاستراحة")).toBeInTheDocument();
    expect(await screen.findByText(/13:00–14:00/)).toBeInTheDocument();
    expect(screen.getByText(/غير مدفوعة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /استراحة/ })).not.toBeInTheDocument();
  });

  it("still honours the legacy breaks_enabled flag", async () => {
    const t = nowSec();
    const legacy = { daily_target_hours: 8, timezone: "Asia/Riyadh", work_start: null, breaks_enabled: true, note_on_stop: "off" };
    const api = makeApi({ open_session: { id: "s1", started_at: t - 60, break_sec: 0 }, open_break: null, worked_sec: 60, server_time: t }, legacy);
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /^استراحة$/ })).toBeInTheDocument();
  });
  it("re-fetches its totals when the local day ends", async () => {
    const t = nowSec();
    // The day ends one second from now; the screen must reload so "today" starts over.
    const api = makeApi({ open_session: null, open_break: null, worked_sec: 7200, server_time: t, day_ends_at: t + 1 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByRole("button", { name: /بدء الدوام/ });
    const statusCalls = () => api.get.mock.calls.filter(([p]) => p === "/me/status").length;
    expect(statusCalls()).toBe(1);
    await waitFor(() => expect(statusCalls()).toBe(2), { timeout: 4000 });
  });

  it("tells a clocked-in employee they have been idle", async () => {
    const t = nowSec();
    const from = t - 25 * 60;
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: t - 3600 }, worked_sec: 3600, server_time: t }),
      { alerts: [{ id: "i1", kind: "idle", from_at: from, to_at: null }], timezone: "UTC", server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(from * 1000));
    expect(await screen.findByText(`ما في نشاط من ${hhmm} (25 د)، والمدير رح يشوفها. إذا عم تشتغل اكتبله شو عم تعمل.`)).toBeInTheDocument();
  });

  it("sends a note on the idle alert", async () => {
    const t = nowSec();
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: t - 3600 }, worked_sec: 3600, server_time: t }),
      { alerts: [{ id: "i1", kind: "idle", from_at: t - 600, to_at: null }], timezone: "UTC", server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.change(await screen.findByLabelText("ملاحظة للمدير"), { target: { value: "كنت بمكالمة" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الملاحظة" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/me/alerts/i1/note", { note: "كنت بمكالمة" }));
  });

  it("refreshes status and alerts every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = withAlerts(makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() }), { alerts: [], timezone: "UTC" });
      wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/alerts"));
      const before = api.get.mock.calls.filter(([p]) => p === "/me/alerts").length;
      await act(async () => { vi.advanceTimersByTime(60000); });
      await waitFor(() => expect(api.get.mock.calls.filter(([p]) => p === "/me/alerts").length).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the tab title while the employee has an alert", async () => {
    document.title = "الدوام";
    const t = nowSec();
    const api = withAlerts(makeApi({ open_session: { id: "s1", started_at: t - 3600 }, worked_sec: 3600, server_time: t }),
      { alerts: [{ id: "i1", kind: "idle", from_at: t - 600, to_at: null }], timezone: "UTC", server_time: t });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    await screen.findByLabelText("ملاحظة للمدير");
    expect(document.title).toBe("⚠️ الدوام");
  });
});
