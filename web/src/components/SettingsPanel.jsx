import { useEffect, useState } from "react";

export default function SettingsPanel({ api }) {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => {}); }, []);
  if (!s) return <div className="muted">جارٍ التحميل…</div>;

  async function save() {
    setMsg(""); setError("");
    try {
      const saved = await api.put("/admin/settings", {
        timezone: s.timezone,
        daily_target_hours: Number(s.daily_target_hours),
        max_session_hours: Number(s.max_session_hours),
        work_start: s.work_start || null,
      });
      setS(saved); setMsg("تم الحفظ");
    } catch (e) {
      setError(e.code === "INVALID_TIMEZONE" ? "المنطقة الزمنية غير صحيحة"
        : e.code === "INVALID_HOURS" ? "الساعات غير صحيحة"
        : e.code === "INVALID_WORK_START" ? "وقت البداية غير صحيح"
        : "حدث خطأ، حاول مرة أخرى");
    }
  }
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });

  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <label>المنطقة الزمنية<br /><input value={s.timezone} onChange={set("timezone")} /></label><br /><br />
      <label>الهدف اليومي (ساعات)<br /><input type="number" step="0.5" value={s.daily_target_hours} onChange={set("daily_target_hours")} /></label><br /><br />
      <label>حد الجلسة (ساعات)<br /><input type="number" step="0.5" value={s.max_session_hours} onChange={set("max_session_hours")} /></label><br /><br />
      <label>بداية الدوام (HH:MM)<br /><input value={s.work_start ?? ""} onChange={set("work_start")} /></label><br /><br />
      <button className="btn" onClick={save}>حفظ</button>
      {msg && <span style={{ color: "var(--positive)", marginRight: 8 }}>{msg}</span>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
