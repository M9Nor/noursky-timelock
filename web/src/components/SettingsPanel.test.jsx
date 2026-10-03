import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import SettingsPanel from "./SettingsPanel.jsx";
import { I18nProvider } from "../i18n.jsx";

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
    expect(screen.getByLabelText("بداية الاستراحة")).toHaveValue("13:00");
    expect(screen.getByLabelText("نهاية الاستراحة")).toHaveValue("14:00");
    expect(screen.getByLabelText("استراحة مدفوعة (تنحسب من الدوام)")).toBeChecked();
    expect(screen.getByLabelText("ملاحظة عند إنهاء الدوام")).toHaveValue("required");
  });

  it("hides the window fields unless the mode is fixed", async () => {
    const api = { get: vi.fn(async () => ({ ...BASE, break_mode: "flexible", break_start: null, break_end: null, break_paid: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نوع الاستراحة")).toHaveValue("flexible");
    expect(screen.queryByLabelText("بداية الاستراحة")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("استراحة مدفوعة (تنحسب من الدوام)")).not.toBeInTheDocument();
  });

  it("saves a fixed unpaid window and the note policy", async () => {
    const saved = { ...BASE, break_mode: "off", break_start: null, break_end: null, break_paid: false };
    const api = { get: vi.fn(async () => saved), put: vi.fn(async (_p, body) => ({ ...saved, ...body })) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.change(await screen.findByLabelText("نوع الاستراحة"), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText("بداية الاستراحة"), { target: { value: "13:00" } });
    fireEvent.change(screen.getByLabelText("نهاية الاستراحة"), { target: { value: "14:00" } });
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
    expect(status.textContent).toContain("17 حدث");
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
    expect(await screen.findByText("حد الخمول لازم يكون بين 1 و240 دقيقة")).toBeInTheDocument();
  });

  it("accepts a one-minute idle threshold and explains the 1–240 range", async () => {
    const err = Object.assign(new Error("INVALID_IDLE_MINUTES"), { code: "INVALID_IDLE_MINUTES" });
    const api = {
      get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, activity_monitoring: true, idle_minutes: 30 } : { installed: false })),
      put: vi.fn(async () => { throw err; }),
    };
    wrap(<SettingsPanel api={api} />);
    const idle = await screen.findByLabelText("حد الخمول (دقائق)");
    expect(idle).toHaveAttribute("min", "1");
    fireEvent.change(idle, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put.mock.calls[0][1].idle_minutes).toBe(1));
    expect(await screen.findByText("حد الخمول لازم يكون بين 1 و240 دقيقة")).toBeInTheDocument();
  });

  it("shows not connected after an uninstall even though an old event time remains", async () => {
    const last = Date.UTC(2026, 8, 20, 8, 42) / 1000;
    wrap(<SettingsPanel api={awApi({ ...AW, activity_monitoring: true }, { installed: false, has_activity_scope: true, last_event_at: last, events_24h: 0 })} />);
    const status = await screen.findByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("غير مربوط"));
    expect(status.textContent).not.toContain("✓ مربوط");
  });

  it("shows connected when events flow although the scope was not stored", async () => {
    const last = Date.UTC(2026, 8, 29, 8, 42) / 1000;
    wrap(<SettingsPanel api={awApi({ ...AW, activity_monitoring: true }, { installed: true, has_activity_scope: false, last_event_at: last, events_24h: 3 })} />);
    const status = await screen.findByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("✓ مربوط"));
    expect(status.textContent).toContain("3 حدث");
  });

  it("keeps the settings form usable when the connection status fails", async () => {
    const api = {
      get: vi.fn(async (path) => { if (path === "/admin/ghl-connection") throw new Error("boom"); return AW; }),
      put: vi.fn(),
    };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("مراقبة النشاط")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /حفظ/ })).toBeInTheDocument();
    const status = screen.getByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("تعذّر فحص حالة الربط مع GHL"));
    expect(screen.queryByText("حدث خطأ، حاول مرة أخرى")).not.toBeInTheDocument();
  });

  const WH = { ...BASE, work_end: "17:00", work_days: 127, activity_monitoring: true, idle_minutes: 30 };

  it("shows the working-day end and the seven work-day boxes", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByLabelText("نهاية الدوام")).toHaveValue("17:00");
    for (const d of ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"]) {
      expect(screen.getByLabelText(d)).toBeChecked();
    }
  });

  it("sends work_end and the work-day bitmask (Friday off = 95)", async () => {
    const api = {
      get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })),
      put: vi.fn(async (_p, b) => ({ ...WH, ...b })),
    };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByLabelText("الجمعة"));
    fireEvent.change(screen.getByLabelText("نهاية الدوام"), { target: { value: "16:30" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toMatchObject({ work_end: "16:30", work_days: 95 });
  });

  it("hints that working hours are needed while monitoring is on without an end", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...WH, work_end: null } : { installed: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByText("حدّد بداية ونهاية الدوام لتشتغل تنبيهات العمل بدون دوام")).toBeInTheDocument();
  });

  it("counts active GHL users who never opened TimeClock", async () => {
    const conn = { installed: true, has_activity_scope: true, last_event_at: null, events_24h: 3, unknown_active_users: 2 };
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? WH : conn)), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    expect(await screen.findByText("في نشاط بآخر 7 أيام من 2 مستخدمين ما فتحوا TimeClock بعد")).toBeInTheDocument();
  });

  it("explains an invalid working-day end", async () => {
    const err = Object.assign(new Error("INVALID_WORK_END"), { code: "INVALID_WORK_END" });
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })), put: vi.fn(async () => { throw err; }) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText("نهاية الدوام غير صحيحة (لازم تكون بعد البداية)")).toBeInTheDocument();
  });

  it("maps each weekday box to its bit (Saturday off = 63, Sunday off = 126)", async () => {
    for (const [day, expected] of [["السبت", 63], ["الأحد", 126]]) {
      const api = {
        get: vi.fn(async (p) => (p === "/admin/settings" ? WH : { installed: false })),
        put: vi.fn(async (_p, b) => ({ ...WH, ...b })),
      };
      const { unmount } = wrap(<SettingsPanel api={api} />);
      fireEvent.click(await screen.findByLabelText(day));
      fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
      await waitFor(() => expect(api.put).toHaveBeenCalled());
      expect(api.put.mock.calls[0][1].work_days).toBe(expected);
      unmount();
    }
  });
  it("uses time pickers for working hours and breaks", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, break_mode: "fixed", break_start: "13:00", break_end: "14:00", work_end: "17:00" } : { installed: false })), put: vi.fn() };
    wrap(<SettingsPanel api={api} />);
    for (const label of ["بداية الدوام", "نهاية الدوام", "بداية الاستراحة", "نهاية الاستراحة"]) {
      expect(await screen.findByLabelText(label)).toHaveAttribute("type", "time");
    }
  });
  it("saves the company language", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, locale: "ar" } : { installed: false })), put: vi.fn(async (_p, b) => b) };
    wrap(<SettingsPanel api={api} />);
    fireEvent.change(await screen.findByLabelText("لغة الشركة"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put.mock.calls[0][1].locale).toBe("en"));
  });

  it("switches this screen to the saved company language without touching the personal choice", async () => {
    const onChange = vi.fn();
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, locale: "ar" } : { installed: false })), put: vi.fn(async (_p, b) => ({ ...b })) };
    render(<I18nProvider locale="ar" onChange={onChange}><ToastProvider><SettingsPanel api={api} /></ToastProvider></I18nProvider>);
    fireEvent.change(await screen.findByLabelText("لغة الشركة"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
    expect(onChange).not.toHaveBeenCalled();
    expect(api.put).toHaveBeenCalledTimes(1);
  });
  it("keeps the screen language when the company language is unchanged", async () => {
    const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, locale: "ar" } : { installed: false })), put: vi.fn(async (_p, b) => ({ ...b })) };
    render(<I18nProvider locale="ar"><ToastProvider><SettingsPanel api={api} /></ToastProvider></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(document.documentElement.dir).toBe("rtl");
  });
});
