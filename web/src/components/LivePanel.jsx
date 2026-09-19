import { useEffect, useRef, useState } from "react";
import { formatDuration, serverOffset, nowWithOffset } from "../time.js";

export default function LivePanel({ api }) {
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
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { clearInterval(poll); clearInterval(t); };
  }, []);

  if (!data) return <div className="muted">جارٍ التحميل…</div>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr><th>الموظف</th><th>الحالة</th><th>المدة</th></tr></thead>
      <tbody>
        {data.employees.map((e) => {
          const working = e.session_id != null;
          const dur = working ? nowWithOffset(offsetRef.current) - e.started_at : 0;
          return (
            <tr key={e.user_id}>
              <td>{e.name}</td>
              <td style={{ color: working ? "var(--positive)" : "var(--muted)" }}>
                {working ? "شغّال الآن" : "غير متصل"}
              </td>
              <td>{working ? formatDuration(dur) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
