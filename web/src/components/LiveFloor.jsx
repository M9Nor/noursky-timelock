import { useEffect, useRef, useState } from "react";
import KpiRow from "./KpiRow.jsx";
import { formatDuration, serverOffset, nowWithOffset } from "../time.js";

const initials = (n) => (n || "؟").trim().charAt(0);

export default function LiveFloor({ api }) {
  const [data, setData] = useState(null);
  const [, setTick] = useState(0);
  const offsetRef = useRef(0);

  async function refresh() {
    const d = await api.get("/admin/live");
    offsetRef.current = serverOffset(d.server_time);
    setData(d);
  }
  useEffect(() => {
    refresh().catch(() => {});
    const poll = setInterval(() => refresh().catch(() => {}), 30000);
    const tick = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  if (!data) return <div className="panel muted">جارٍ التحميل…</div>;
  const working = data.employees.filter((e) => e.session_id != null);
  const offline = data.employees.filter((e) => e.session_id == null);
  const lane = (label, people, live) => (
    <div className="lane" aria-label={`${label}: ${people.length}`}>
      <div className="lane-h"><span>{label}</span><b>{people.length}</b></div>
      {people.length ? people.map((p) => (
        <div className="person" key={p.user_id}>
          <span className="avatar" aria-hidden="true">{initials(p.name)}</span>
          <div style={{ minWidth: 0 }}>
            <div className="n">{p.name}</div>
            {live && <div className="m">{formatDuration(nowWithOffset(offsetRef.current) - p.started_at)}</div>}
          </div>
        </div>
      )) : <div className="hint" style={{ textAlign: "center", padding: "12px 0" }}>لا أحد</div>}
    </div>
  );

  return (
    <>
      <KpiRow live={data} />
      <section className="panel">
        <div className="panel-h"><h2>الفريق الآن</h2></div>
        <div className="floor">
          {lane("داخل الدوام", working, true)}
          {lane("غير متصل", offline, false)}
        </div>
      </section>
    </>
  );
}
