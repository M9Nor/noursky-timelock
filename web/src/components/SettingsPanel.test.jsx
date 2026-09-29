import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

describe("SettingsPanel", () => {
  it("loads settings then saves via PUT", async () => {
    const api = {
      get: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15 })),
      put: vi.fn(async () => ({ timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15 })),
    };
    wrap(<SettingsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/admin/settings"));
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/admin/settings", expect.objectContaining({ timezone: "Asia/Riyadh" })));
  });

  it("renders the late grace field", async () => {
    const api = {
      get: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15 })),
      put: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15 })),
    };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("سماح التأخير (دقائق)")).toBeInTheDocument();
  });
  it("does not send 0 when the grace field is cleared", async () => {
    const api = {
      get: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15 })),
      put: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15 })),
    };
    wrap(<SettingsPanel api={api} />);
    const grace = await screen.findByLabelText("سماح التأخير (دقائق)");
    fireEvent.change(grace, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1].late_grace_minutes).toBe(15);
  });

  const BASE = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15, note_on_stop: "off" };

  it("shows a saved fixed break with its window and pay", async () => {
    const api = {
      get: vi.fn(async () => ({ ...BASE, note_on_stop: "required", break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: true })),
      put: vi.fn(),
    };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نوع الاستراحة")).toHaveValue("fixed");
    expect(screen.getByLabelText("بداية الاستراحة (HH:MM)")).toHaveValue("13:00");
    expect(screen.getByLabelText("نهاية الاستراحة (HH:MM)")).toHaveValue("14:00");
    expect(screen.getByLabelText("استراحة مدفوعة (تنحسب من الدوام)")).toBeChecked();
    expect(screen.getByLabelText("ملاحظة عند إنهاء الدوام")).toHaveValue("required");
  });

  it("hides the window fields unless the mode is fixed", async () => {
    const api = { get: vi.fn(async () => ({ ...BASE, break_mode: "flexible", break_start: null, break_end: null, break_paid: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نوع الاستراحة")).toHaveValue("flexible");
    expect(screen.queryByLabelText("بداية الاستراحة (HH:MM)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("استراحة مدفوعة (تنحسب من الدوام)")).not.toBeInTheDocument();
  });

  it("saves a fixed unpaid window and the note policy", async () => {
    const saved = { ...BASE, break_mode: "off", break_start: null, break_end: null, break_paid: false };
    const api = { get: vi.fn(async () => saved), put: vi.fn(async (_p, body) => ({ ...saved, ...body })) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.change(await screen.findByLabelText("نوع الاستراحة"), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText("بداية الاستراحة (HH:MM)"), { target: { value: "13:00" } });
    fireEvent.change(screen.getByLabelText("نهاية الاستراحة (HH:MM)"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("ملاحظة عند إنهاء الدوام"), { target: { value: "optional" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toEqual(expect.objectContaining({
      break_mode: "fixed", break_start: "13:00", break_end: "14:00", break_paid: false, note_on_stop: "optional",
    }));
    expect(api.put.mock.calls[0][1]).not.toHaveProperty("breaks_enabled");
  });

  it("explains an invalid break window", async () => {
    const api = {
      get: vi.fn(async () => ({ ...BASE, break_mode: "fixed", break_start: "14:00", break_end: "13:00", break_paid: false })),
      put: vi.fn(async () => { throw Object.assign(new Error("x"), { code: "INVALID_BREAK_WINDOW" }); }),
    };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText("وقت الاستراحة غير صحيح (البداية لازم تكون قبل النهاية)")).toBeInTheDocument();
  });

  const AW = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15, note_on_stop: "off", break_mode: "off", activity_monitoring: false, idle_minutes: 30 };
  const awApi = (settings, connection, put = vi.fn(async (_p, body) => ({ ...settings, ...body }))) => ({
    get: vi.fn(async (path) => (path === "/admin/ghl-connection" ? connection : settings)),
    put,
  });

  it("saves the activity monitoring toggle and idle threshold", async () => {
    const api = awApi(AW, { installed: true, has_activity_scope: true, last_event_at: null, events_24h: 0 });
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByLabelText("مراقبة النشاط"));
    fireEvent.change(screen.getByLabelText("حد الخمول (دقائق)"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toEqual(expect.objectContaining({ activity_monitoring: true, idle_minutes: 45 }));
  });

  it("hides the idle threshold while monitoring is off", async () => {
    wrap(<SettingsPanel api={awApi(AW, { installed: false, has_activity_scope: false, last_event_at: null, events_24h: 0 })} />);
    expect(await screen.findByLabelText("مراقبة النشاط")).not.toBeChecked();
    expect(screen.queryByLabelText("حد الخمول (دقائق)")).not.toBeInTheDocument();
  });

  it("shows a working connection with the last event time and the 24h count", async () => {
    const last = Date.UTC(2026, 8, 29, 8, 42) / 1000; // 11:42 in Riyadh
    wrap(<SettingsPanel api={awApi({ ...AW, activity_monitoring: true }, { installed: true, has_activity_scope: true, last_event_at: last, events_24h: 17 })} />);
    const status = await screen.findByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("مربوط"));
    expect(status.textContent).toContain("11:42");
    expect(status.textContent).toContain("17");
    expect(status.textContent).not.toContain("غير مربوط");
  });

  it("tells the manager to reinstall when the activity scope is missing", async () => {
    wrap(<SettingsPanel api={awApi(AW, { installed: true, has_activity_scope: false, last_event_at: null, events_24h: 0 })} />);
    const status = await screen.findByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("غير مربوط"));
    expect(status.textContent).toContain("أعد تثبيت التطبيق");
  });

  it("explains an idle threshold out of range", async () => {
    const put = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "INVALID_IDLE_MINUTES" }); });
    wrap(<SettingsPanel api={awApi({ ...AW, activity_monitoring: true, idle_minutes: 5 }, { installed: true, has_activity_scope: true, last_event_at: null, events_24h: 0 }, put)} />);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText("حد الخمول لازم يكون بين 10 و240 دقيقة")).toBeInTheDocument();
  });
});
