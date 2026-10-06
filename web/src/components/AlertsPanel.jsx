import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatTime, formatIdle } from "../time.js";
import { useAlertTitle } from "../alertTitle.js";
import { useI18n } from "../i18n.jsx";
import { usePolling } from "../usePolling.js";

const DAY = 86400;

// The line under an alert's name (spec §6, §12.4).
function alertLine(a, tz, serverNow, t, locale) {
  if (a.kind === "idle") {
    const from = formatTime(a.from_at, tz);
    if (a.to_at == null) return t("alerts.idleOngoing", { from, dur: formatIdle(Math.max(0, (serverNow ?? a.from_at) - a.from_at), locale) });
    return t("alerts.idleRange", { from, to: formatTime(a.to_at, tz), dur: formatIdle(a.to_at - a.from_at, locale) });
  }
  return t("alerts.working", { time: formatTime(a.from_at, tz) });
}

// Open "working, not clocked in" alerts plus, read-only, notes employees left on alerts that were
// resolved by clocking in during the last 24 hours (spec §6). Hidden while there is neither.
export default function AlertsPanel({ api }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState({ alerts: [], notes: [], timezone: null, serverNow: null });
  const toast = useToast();

  async function load() {
    const [d, r] = await Promise.all([
      api.get("/admin/alerts?status=open"),
      api.get("/admin/alerts?status=resolved").catch(() => null), // never hide open alerts
    ]);
    const serverNow = r?.server_time ?? d.server_time;
    const notes = serverNow == null ? [] : (r?.alerts ?? []).filter(
      (a) => a.kind === "working_not_clocked_in" && a.employee_note && a.resolved_at != null && a.resolved_at > serverNow - DAY
    );
    setData({ alerts: d.alerts ?? [], notes, timezone: d.timezone ?? null, serverNow: d.server_time ?? null });
  }
  useEffect(() => { load().catch(() => {}); }, []);
  usePolling(load, 30000);

  async function dismiss(id) {
    try {
      await api.post(`/admin/alerts/${id}/dismiss`);
      setData((d) => ({ ...d, alerts: d.alerts.filter((a) => a.id !== id) }));
      toast(t("alerts.dismissed"));
    } catch {
      // Already handled elsewhere (dismissed in another tab, or resolved by clock-in): resync.
      await load().catch(() => {});
    }
  }

  useAlertTitle(data.alerts.length > 0);
  if (!data.alerts.length && !data.notes.length) return null;
  return (
    <section className="panel alerts" aria-label={t("alerts.title")}>
      <div className="panel-h"><h2>{t("alerts.title")}</h2>{data.alerts.length > 0 && <b className="count">{data.alerts.length}</b>}</div>
      {data.alerts.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{a.name || a.user_id}</div>
            <div className="m">{alertLine(a, data.timezone, data.serverNow, t, locale)}</div>
            {a.employee_note && <div className="note">{a.employee_note}</div>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => dismiss(a.id)}>{t("alerts.dismiss")}</Button>
        </div>
      ))}
      {data.notes.length > 0 && <h3>{t("alerts.notesTitle")}</h3>}
      {data.notes.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{a.name || a.user_id}</div>
            <div className="m">{t("alerts.noteResolved", { time: formatTime(a.from_at, data.timezone) })}</div>
            <div className="note">{a.employee_note}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
