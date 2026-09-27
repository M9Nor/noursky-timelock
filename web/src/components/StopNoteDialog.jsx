import { useState } from "react";
import Button from "./Button.jsx";

const NOTE_MAX = 500;

export default function StopNoteDialog({ required, loading, onConfirm, onCancel }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function confirm() {
    const trimmed = note.trim();
    if (required && !trimmed) { setError("الملاحظة مطلوبة لإنهاء الدوام"); return; }
    onConfirm(trimmed);
  }

  return (
    <div className="overlay">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="stop-note-title">
        <h2 id="stop-note-title">إنهاء الدوام</h2>
        <p className="hint">{required ? "اكتب باختصار ما أنجزته." : "يمكنك كتابة ملاحظة قصيرة عمّا أنجزته (اختياري)."}</p>
        <div className="field">
          <label htmlFor="stop-note">ملاحظة</label>
          <textarea id="stop-note" maxLength={NOTE_MAX} value={note}
            aria-invalid={error ? "true" : undefined}
            onChange={(e) => { setNote(e.target.value); setError(""); }} />
          {error && <span className="err">{error}</span>}
        </div>
        <div className="dlg-a">
          <Button variant="danger" onClick={confirm} loading={loading}>تأكيد الإنهاء</Button>
          <Button variant="ghost" onClick={onCancel}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}
