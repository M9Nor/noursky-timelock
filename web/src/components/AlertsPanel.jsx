import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatTime, formatIdle } from "../time.js";
import { useAlertTitle } from "../alertTitle.js";

const DAY = 86400;

// The line under an alert's name (spec §6, §12.4).
function alertLine(a, tz, serverNow) {
  if (a.kind === "idle") {
    const from = formatTime(a.from_at, tz);
    if (a.to_at == null) return `بدون نشاط من ${from} · ${formatIdle(Math.max(0, (serverNow ?? a.from_at) - a.from_at))}`;
    return `بدون نشاط من ${from} لـ ${formatTime(a.to_at, tz)} (${formatIdle(a.to_at - a.from_at)})`;
  }
  return `عم يشتغل بدون دوام من ${formatTime(a.from_at, tz)}`;
}

// Open "working, not clocked in" alerts plus, read-only, notes employees left on alerts that were
// resolved by clocking in during the last 24 hours (spec §6). Hidden while there is neither.
export default function AlertsPanel({ api }) {
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
  useEffect(() => {
    load().catch(() => {});
    const poll = setInterval(() => load().catch(() => {}), 60000);
    return () => clearInterval(poll);
  }, []);

  async function dismiss(id) {
    try {
      await api.post(`/admin/alerts/${id}/dismiss`);
      setData((d) => ({ ...d, alerts: d.alerts.filter((a) => a.id !== id) }));
      toast("تم تجاهل التنبيه");
    } catch {
      // Already handled elsewhere (dismissed in another tab, or resolved by clock-in): resync.
      await load().catch(() => {});
    }
  }

  useAlertTitle(data.alerts.length > 0);
  if (!data.alerts.length && !data.notes.length) return null;
  return (
    <section className="panel alerts" aria-label="تنبيهات النشاط">
      <div className="panel-h"><h2>تنبيهات النشاط</h2>{data.alerts.length > 0 && <b className="count">{data.alerts.length}</b>}</div>
      {data.alerts.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{a.name || a.user_id}</div>
            <div className="m">{alertLine(a, data.timezone, data.serverNow)}</div>
            {a.employee_note && <div className="note">{a.employee_note}</div>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => dismiss(a.id)}>تجاهل</Button>
        </div>
      ))}
      {data.notes.length > 0 && <h3>ملاحظات الموظفين</h3>}
      {data.notes.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{a.name || a.user_id}</div>
            <div className="m">كان عم يشتغل بدون دوام من {formatTime(a.from_at, data.timezone)} · بلّش الدوام</div>
            <div className="note">{a.employee_note}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
