import { useState } from "react";
import Button from "./Button.jsx";

const toLocalInput = (sec) => {
  const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, "0");
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
      await api.patch(`/admin/sessions/${session.id}`, { started_at: fromLocalInput(start), ended_at: fromLocalInput(end), reason: reason.trim() });
      onSaved();
    } catch (e) {
      setError(e.code === "INVALID_TIMES" ? "الأوقات غير صحيحة" : "حدث خطأ، حاول مرة أخرى");
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,20,37,.5)", display: "grid", placeItems: "center", zIndex: 60 }}>
      <div className="dlg" style={{ background: "var(--panel)", borderRadius: "var(--r-lg)", width: "min(480px, calc(100vw - 32px))" }}>
        <h2>تعديل الجلسة</h2>
        <div className="row2">
          <div className="field"><label>البداية</label><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="field"><label>النهاية</label><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        <div className="field"><label>سبب التعديل</label><textarea placeholder="سبب التعديل" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {error && <div className="field"><span className="err">{error}</span></div>}
        <div className="dlg-a">
          <Button onClick={save} loading={saving}>حفظ</Button>
          <Button variant="ghost" onClick={onClose}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}
