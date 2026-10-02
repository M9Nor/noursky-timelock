import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatTime } from "../time.js";

// Open "working, not clocked in" alerts (spec §6). Hidden while there are none.
export default function AlertsPanel({ api }) {
  const [data, setData] = useState({ alerts: [], timezone: null });
  const toast = useToast();

  async function load() {
    const d = await api.get("/admin/alerts?status=open");
    setData({ alerts: d.alerts ?? [], timezone: d.timezone ?? null });
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

  if (!data.alerts.length) return null;
  return (
    <section className="panel alerts" aria-label="تنبيهات النشاط">
      <div className="panel-h"><h2>تنبيهات النشاط</h2><b className="count">{data.alerts.length}</b></div>
      {data.alerts.map((a) => (
        <div className="alert-row" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <div className="n">{a.name || a.user_id}</div>
            <div className="m">عم يشتغل بدون دوام من {formatTime(a.from_at, data.timezone)}</div>
            {a.employee_note && <div className="note">{a.employee_note}</div>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => dismiss(a.id)}>تجاهل</Button>
        </div>
      ))}
    </section>
  );
}
