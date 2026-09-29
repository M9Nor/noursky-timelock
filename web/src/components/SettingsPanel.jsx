import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatStamp } from "../time.js";

export default function SettingsPanel({ api }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState("");
  const [conn, setConn] = useState(null);
  const [connFailed, setConnFailed] = useState(false);
  const toast = useToast();

  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => setError("حدث خطأ، حاول مرة أخرى")); }, []);
  // The connection status is informative only; a failure never blocks the settings form.
  useEffect(() => { api.get("/admin/ghl-connection").then(setConn).catch(() => setConnFailed(true)); }, []);
  if (!s && !error) return <div className="panel muted">جارٍ التحميل…</div>;
  if (!s) return <div className="panel error">حدث خطأ، حاول مرة أخرى</div>;

  // last_event_at outlives an uninstall, so it only feeds the sub-text, never "connected".
  const connected = Boolean(conn && conn.installed && (conn.has_activity_scope || conn.events_24h > 0));
  const connectionText = connFailed || (!conn && s)
    ? (connFailed ? "تعذّر فحص حالة الربط مع GHL" : "جارٍ فحص الربط مع GHL…")
    : connected
      ? `✓ مربوط — ${conn.last_event_at != null
        ? `آخر حدث وصل: ${formatStamp(conn.last_event_at, s.timezone)}`
        : "لسا ما وصل ولا حدث"}${s.activity_monitoring ? ` · وصل ${conn.events_24h ?? 0} حدث بآخر 24 ساعة` : ""}`
      : "✗ غير مربوط — أعد تثبيت التطبيق من الـ Marketplace لتتفعّل صلاحية النشاط";

  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  async function save() {
    setError("");
    try {
      const saved = await api.put("/admin/settings", {
        timezone: s.timezone,
        daily_target_hours: Number(s.daily_target_hours),
        max_session_hours: Number(s.max_session_hours),
        work_start: s.work_start || null,
        // An emptied field is "" — Number("") is 0, which would silently mean
        // "late one second after work_start". Treat empty/absent as the default.
        late_grace_minutes: s.late_grace_minutes === "" || s.late_grace_minutes == null
          ? 15
          : Number(s.late_grace_minutes),
        break_mode: s.break_mode ?? "off",
        break_start: s.break_start || null,
        break_end: s.break_end || null,
        break_paid: Boolean(s.break_paid),
        note_on_stop: s.note_on_stop ?? "off",
        activity_monitoring: Boolean(s.activity_monitoring),
        // Same empty-field rule as the grace: an emptied field means the default.
        idle_minutes: s.idle_minutes === "" || s.idle_minutes == null ? 30 : Number(s.idle_minutes),
      });
      setS(saved); toast("تم الحفظ");
    } catch (e) {
      setError(e.code === "INVALID_TIMEZONE" ? "المنطقة الزمنية غير صحيحة"
        : e.code === "INVALID_HOURS" ? "الساعات غير صحيحة"
        : e.code === "INVALID_WORK_START" ? "وقت البداية غير صحيح"
        : e.code === "INVALID_GRACE" ? "سماح التأخير غير صحيح"
        : e.code === "INVALID_BREAKS" ? "إعداد الاستراحات غير صحيح"
        : e.code === "INVALID_BREAK_MODE" ? "نوع الاستراحة غير صحيح"
        : e.code === "INVALID_BREAK_WINDOW" ? "وقت الاستراحة غير صحيح (البداية لازم تكون قبل النهاية)"
        : e.code === "INVALID_IDLE_MINUTES" ? "حد الخمول لازم يكون بين 10 و240 دقيقة"
        : e.code === "INVALID_ACTIVITY_MONITORING" ? "إعداد مراقبة النشاط غير صحيح"
        : e.code === "INVALID_NOTE_POLICY" ? "إعداد الملاحظة غير صحيح"
        : "حدث خطأ، حاول مرة أخرى");
    }
  }

  return (
    <section className="panel" style={{ maxWidth: 480 }}>
      <div className="panel-h"><h2>الإعدادات</h2></div>
      <div className="field"><label>المنطقة الزمنية</label><input value={s.timezone} onChange={set("timezone")} /></div>
      <div className="field"><label>الهدف اليومي (ساعات)</label><input type="number" step="0.5" value={s.daily_target_hours} onChange={set("daily_target_hours")} /></div>
      <div className="field"><label>حد الجلسة (ساعات)</label><input type="number" step="0.5" value={s.max_session_hours} onChange={set("max_session_hours")} /></div>
      <div className="field"><label htmlFor="work-start">بداية الدوام (HH:MM)</label><input id="work-start" value={s.work_start ?? ""} onChange={set("work_start")} /></div>
      <div className="field"><label htmlFor="grace">سماح التأخير (دقائق)</label><input id="grace" type="number" step="1" min="0" max="240" value={s.late_grace_minutes ?? 15} onChange={set("late_grace_minutes")} /></div>
      <div className="field">
        <label htmlFor="break-mode">نوع الاستراحة</label>
        <select id="break-mode" value={s.break_mode ?? "off"} onChange={set("break_mode")}>
          <option value="off">بدون</option>
          <option value="fixed">ثابتة (يحددها المدير)</option>
          <option value="flexible">مرنة (الموظف يضغط)</option>
        </select>
      </div>
      {s.break_mode === "fixed" && (
        <>
          <div className="row2">
            <div className="field"><label htmlFor="break-start">بداية الاستراحة (HH:MM)</label><input id="break-start" value={s.break_start ?? ""} onChange={set("break_start")} /></div>
            <div className="field"><label htmlFor="break-end">نهاية الاستراحة (HH:MM)</label><input id="break-end" value={s.break_end ?? ""} onChange={set("break_end")} /></div>
          </div>
          <div className="field check">
            <label><input type="checkbox" checked={Boolean(s.break_paid)} onChange={(e) => setS({ ...s, break_paid: e.target.checked })} />استراحة مدفوعة (تنحسب من الدوام)</label>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="note-policy">ملاحظة عند إنهاء الدوام</label>
        <select id="note-policy" value={s.note_on_stop ?? "off"} onChange={set("note_on_stop")}>
          <option value="off">بدون</option>
          <option value="optional">اختيارية</option>
          <option value="required">إلزامية</option>
        </select>
      </div>
      <div className="field check">
        <label><input id="activity-monitoring" type="checkbox" checked={Boolean(s.activity_monitoring)} onChange={(e) => setS({ ...s, activity_monitoring: e.target.checked })} />مراقبة النشاط</label>
      </div>
      {s.activity_monitoring && (
        <div className="field">
          <label htmlFor="idle-minutes">حد الخمول (دقائق)</label>
          <input id="idle-minutes" type="number" step="1" min="10" max="240" value={s.idle_minutes ?? 30} onChange={set("idle_minutes")} />
        </div>
      )}
      <div className="field">
        <p className="hint" role="status" aria-label="حالة الربط مع GHL">{connectionText}</p>
        <p className="hint">لازم يكون الموظفين عارفين إنه نشاطهم مراقب.</p>
      </div>
      {error && <div className="field"><span className="err">{error}</span></div>}
      <div className="dlg-a"><Button onClick={save}>حفظ</Button></div>
    </section>
  );
}
