import { useState } from "react";
import Button from "./Button.jsx";
import { useI18n } from "../i18n.jsx";

const REASON_MAX = 300;

// Asking the manager to end the shift before work end (spec 2026-10-07 §5). The reason is required.
export default function EarlyLeaveDialog({ workEnd, loading, error, onSend, onCancel }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const shown = missing ? t("earlyLeave.reasonRequired") : error || "";

  function send() {
    const trimmed = reason.trim();
    if (!trimmed) { setMissing(true); return; }
    onSend(trimmed);
  }

  return (
    <div className="overlay">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="early-leave-title"
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
        <h2 id="early-leave-title">{t("earlyLeave.title")}</h2>
        <p className="hint">{t("earlyLeave.hint", { time: workEnd ?? "—" })}</p>
        <div className="field">
          <label htmlFor="early-leave-reason">{t("earlyLeave.reason")}</label>
          <textarea id="early-leave-reason" maxLength={REASON_MAX} value={reason} autoFocus
            aria-invalid={shown ? "true" : undefined} aria-describedby={shown ? "early-leave-err" : undefined}
            onChange={(e) => { setReason(e.target.value); setMissing(false); }} />
          {shown && <span className="err" id="early-leave-err">{shown}</span>}
        </div>
        <div className="dlg-a">
          <Button onClick={send} loading={loading}>{t("earlyLeave.send")}</Button>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>{t("earlyLeave.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
