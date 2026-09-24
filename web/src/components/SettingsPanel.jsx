import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";

export default function SettingsPanel({ api }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => setError("حدث خطأ، حاول مرة أخرى")); }, []);
  if (!s && !error) return <div className="panel muted">جارٍ التحميل…</div>;
  if (!s) return <div className="panel error">حدث خطأ، حاول مرة أخرى</div>;

  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  async function save() {
    setError("");
    try {
      const saved = await api.put("/admin/settings", {
        timezone: s.timezone,
        daily_target_hours: Number(s.daily_target_hours),
        max_session_hours: Number(s.max_session_hours),
        work_start: s.work_start || null,
        late_grace_minutes: Number(s.late_grace_minutes ?? 15),
      });
      setS(saved); toast("تم الحفظ");
    } catch (e) {
      setError(e.code === "INVALID_TIMEZONE" ? "المنطقة الزمنية غير صحيحة"
        : e.code === "INVALID_HOURS" ? "الساعات غير صحيحة"
        : e.code === "INVALID_WORK_START" ? "وقت البداية غير صحيح"
        : e.code === "INVALID_GRACE" ? "سماح التأخير غير صحيح"
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
      {error && <div className="field"><span className="err">{error}</span></div>}
      <div className="dlg-a"><Button onClick={save}>حفظ</Button></div>
    </section>
  );
}
