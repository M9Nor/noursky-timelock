import { useState } from "react";

// datetime-local <-> unix seconds (local wall time, no TZ math — matches display).
const toLocalInput = (sec) => {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);

export default function SessionEditModal({ api, session, onClose, onSaved }) {
  const [start, setStart] = useState(toLocalInput(session.started_at));
  const [end, setEnd] = useState(toLocalInput(session.ended_at ?? session.started_at + 3600));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!reason.trim()) { setError("سبب التعديل مطلوب"); return; }
    setSaving(true); setError("");
    try {
      await api.patch(`/admin/sessions/${session.id}`, {
        started_at: fromLocalInput(start),
        ended_at: fromLocalInput(end),
        reason: reason.trim(),
      });
      onSaved();
    } catch (e) {
      setError(e.code === "INVALID_TIMES" ? "الأوقات غير صحيحة" : "حدث خطأ، حاول مرة أخرى");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center" }}>
      <div className="card" style={{ width: 360 }}>
        <h3 style={{ color: "var(--subheading)" }}>تعديل الجلسة</h3>
        <label>البداية<br /><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <br /><br />
        <label>النهاية<br /><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <br /><br />
        <textarea placeholder="سبب التعديل" value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%" }} rows={2} />
        {error && <div className="error">{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={save} disabled={saving}>حفظ</button>
          <button className="btn" style={{ background: "var(--muted)" }} onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}
