import { useEffect, useState } from "react";
import { formatHours } from "../time.js";
import SessionEditModal from "./SessionEditModal.jsx";

export function todayRange() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - 86400, to };
}
export function weekRange() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - 7 * 86400, to };
}
export function monthRange() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - 30 * 86400, to };
}

function completionColor(pct) {
  if (pct >= 90) return "var(--positive)";
  if (pct >= 60) return "var(--warning)";
  return "var(--negative)";
}

export default function ReportPanel({ api }) {
  const [range, setRange] = useState(weekRange());
  const [report, setReport] = useState(null);
  const [detail, setDetail] = useState(null); // { user_id, name, sessions }
  const [editing, setEditing] = useState(null); // a session row

  async function load() {
    const r = await api.get(`/admin/report?from=${range.from}&to=${range.to}`);
    setReport(r);
  }
  useEffect(() => { load().catch(() => {}); }, [range.from, range.to]);

  async function openDetail(emp) {
    const d = await api.get(`/admin/sessions?from=${range.from}&to=${range.to}&user_id=${emp.user_id}`);
    setDetail({ ...emp, sessions: d.sessions });
  }

  if (!report) return <div className="muted">جارٍ التحميل…</div>;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className="btn" onClick={() => setRange(todayRange())}>اليوم</button>
        <button className="btn" onClick={() => setRange(weekRange())}>الأسبوع</button>
        <button className="btn" onClick={() => setRange(monthRange())}>الشهر</button>
        <a className="btn" href={`/admin/export.csv?from=${range.from}&to=${range.to}`}>تصدير CSV</a>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>الموظف</th><th>الساعات</th><th>الهدف</th><th>الإنجاز</th><th>أيام</th><th>تلقائي</th></tr></thead>
        <tbody>
          {report.employees.map((e) => {
            const target = e.days_present * report.daily_target_hours;
            const workedH = Number(formatHours(e.worked_sec));
            const pct = target > 0 ? Math.round((workedH / target) * 100) : 0;
            return (
              <tr key={e.user_id} style={{ cursor: "pointer" }} onClick={() => openDetail(e)}>
                <td>{e.name}</td>
                <td>{formatHours(e.worked_sec)}</td>
                <td>{target.toFixed(2)}</td>
                <td style={{ color: completionColor(pct) }}>{pct}%</td>
                <td>{e.days_present}</td>
                <td>{e.auto_closed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {detail && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ color: "var(--subheading)" }}>جلسات: {detail.name}</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th>البداية</th><th>النهاية</th><th>الإغلاق</th><th></th></tr></thead>
            <tbody>
              {detail.sessions.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.started_at * 1000).toLocaleString("en-GB")}</td>
                  <td>{s.ended_at ? new Date(s.ended_at * 1000).toLocaleString("en-GB") : "مفتوحة"}</td>
                  <td>{s.closed_by ?? "—"}</td>
                  <td><button className="btn" onClick={() => setEditing(s)}>تعديل</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SessionEditModal
          api={api}
          session={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); if (detail) await openDetail(detail); }}
        />
      )}
    </div>
  );
}
