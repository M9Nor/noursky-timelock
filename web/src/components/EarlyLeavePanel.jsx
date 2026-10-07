import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatStamp, formatTime } from "../time.js";
import { useAlertTitle } from "../alertTitle.js";
import { useI18n } from "../i18n.jsx";
import { usePolling, REFRESH_EVENT } from "../usePolling.js";

// Early-leave requests for the manager (spec 2026-10-07 §5): pending ones to approve or decline,
// and the history of the last 30 days. Hidden while there is neither.
export default function EarlyLeavePanel({ api }) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState({ pending: [], history: [], timezone: null });
  const [tab, setTab] = useState("pending");
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [p, h] = await Promise.all([
      api.get("/admin/early-leave?status=pending"),
      api.get("/admin/early-leave?status=all&days=30").catch(() => null),
    ]);
    setData({ pending: p.requests ?? [], history: h?.requests ?? [], timezone: p.timezone ?? null });
  }
  useEffect(() => { load().catch(() => {}); }, []);
  usePolling(load, 30000);
  useAlertTitle(data.pending.length > 0);

  async function decide(id, action, body) {
    setBusy(true);
    try {
      await (body ? api.post(`/admin/early-leave/${id}/${action}`, body) : api.post(`/admin/early-leave/${id}/${action}`));
      toast(t(action === "approve" ? "earlyLeave.approvedToast" : "earlyLeave.rejectedToast"));
      setRejecting(null);
      setNote("");
    } catch {
      // Already answered, cancelled or expired elsewhere: the reload below shows the truth.
    } finally {
      setBusy(false);
      // Reloads this panel too; an approval also changes the live floor and the report.
      window.dispatchEvent(new Event(REFRESH_EVENT));
    }
  }

  if (!data.pending.length && !data.history.length) return null;
  const tz = data.timezone;
  const history = data.history.filter((r) => !query.trim() || (r.name ?? "").includes(query.trim()));

  return (
    <section className="panel alerts early-leave" aria-label={t("earlyLeave.panelTitle")}>
      <div className="panel-h">
        <h2>{t("earlyLeave.panelTitle")}</h2>
        {data.pending.length > 0 && <b className="count">{data.pending.length}</b>}
        <div className="toolbar">
          <div className="filters" role="group" aria-label={t("earlyLeave.panelTitle")}>
            <button type="button" aria-pressed={tab === "pending"} onClick={() => setTab("pending")}>{t("earlyLeave.tabPending")}</button>
            <button type="button" aria-pressed={tab === "history"} onClick={() => setTab("history")}>{t("earlyLeave.tabHistory")}</button>
          </div>
          {tab === "history" && (
            <div className="search">
              <label htmlFor="early-q" className="sr">{t("earlyLeave.search")}</label>
              <input id="early-q" type="search" placeholder={t("earlyLeave.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
              <Icon name="search" />
            </div>
          )}
        </div>
      </div>

      {tab === "pending" && (data.pending.length ? data.pending.map((r) => (
        <div className="alert-row" key={r.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{r.name || r.user_id}</div>
            <div className="m">{t("earlyLeave.requestedAt", { time: formatTime(r.requested_at, tz) })}</div>
            <div className="note">{r.reason}</div>
            {rejecting === r.id && (
              <div className="field">
                <label htmlFor={`reject-note-${r.id}`}>{t("earlyLeave.rejectNote")}</label>
                <textarea id={`reject-note-${r.id}`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                <Button variant="danger" size="sm" loading={busy}
                  onClick={() => decide(r.id, "reject", { note: note.trim() })}>{t("earlyLeave.confirmReject")}</Button>
              </div>
            )}
          </div>
          <div className="actions">
            <Button size="sm" loading={busy} onClick={() => decide(r.id, "approve")}>{t("earlyLeave.approve")}</Button>
            <Button variant="ghost" size="sm" disabled={busy}
              onClick={() => { setRejecting(r.id); setNote(""); }}>{t("earlyLeave.reject")}</Button>
          </div>
        </div>
      )) : <p className="muted">{t("earlyLeave.noPending")}</p>)}

      {tab === "history" && (
        <>
          {history.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th>{t("earlyLeave.colEmployee")}</th><th>{t("earlyLeave.colDate")}</th>
                  <th>{t("earlyLeave.colReason")}</th><th>{t("earlyLeave.colStatus")}</th><th>{t("earlyLeave.colAnswer")}</th>
                </tr></thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name || r.user_id}</td>
                      <td className="ltr">{formatStamp(r.requested_at, tz)}</td>
                      <td>{r.reason}</td>
                      <td>{t(`earlyLeave.status.${r.status}`)}</td>
                      <td>
                        {r.decided_by_name && r.decided_at != null && (
                          <div>{t("earlyLeave.answeredBy", { name: r.decided_by_name, time: formatTime(r.decided_at, tz) })}</div>
                        )}
                        {r.manager_note && <div className="muted">{r.manager_note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">{t("earlyLeave.noHistory")}</p>}
        </>
      )}
    </section>
  );
}
