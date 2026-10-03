import { useState } from "react";
import Button from "./Button.jsx";
import { useI18n } from "../i18n.jsx";

const NOTE_MAX = 500;

export default function StopNoteDialog({ required, loading, error, onConfirm, onCancel }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [validationError, setValidationError] = useState("");
  // The required-note check (local) and a failed stop reported by the parent (external,
  // e.g. a generic error or a stale session) share the same `.err` span — only one is
  // ever relevant at a time, and a fresh validation error always wins over a stale one.
  const shownError = (validationError ? t(validationError) : error) || "";

  function confirm() {
    const trimmed = note.trim();
    if (required && !trimmed) { setValidationError("stopNote.required"); return; }
    setValidationError("");
    onConfirm(trimmed);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") onCancel();
  }

  return (
    <div className="overlay">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="stop-note-title" onKeyDown={onKeyDown}>
        <h2 id="stop-note-title">{t("stopNote.title")}</h2>
        <p className="hint">{required ? t("stopNote.hintRequired") : t("stopNote.hintOptional")}</p>
        <div className="field">
          <label htmlFor="stop-note">{t("stopNote.label")}</label>
          <textarea id="stop-note" maxLength={NOTE_MAX} value={note} autoFocus
            aria-invalid={shownError ? "true" : undefined}
            aria-describedby={shownError ? "stop-note-err" : undefined}
            onChange={(e) => { setNote(e.target.value); setValidationError(""); }} />
          {shownError && <span className="err" id="stop-note-err">{shownError}</span>}
        </div>
        <div className="dlg-a">
          <Button variant="danger" onClick={confirm} loading={loading}>{t("stopNote.confirm")}</Button>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>{t("stopNote.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
