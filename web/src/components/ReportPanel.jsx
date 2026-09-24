import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatHours } from "../time.js";
import SessionEditModal from "./SessionEditModal.jsx";

export function todayRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 86400, to }; }
export function weekRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 7 * 86400, to }; }
export function monthRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 30 * 86400, to }; }

const toDateInput = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const fromDateInput = (v, endOfDay) => Math.floor(new Date(v + (endOfDay ? "T23:59:59" : "T00:00:00")).getTime() / 1000);

function completionColor(pct) {
  if (pct >= 90) return "var(--pos)";
  if (pct >= 60) return "var(--warn)";
  return "var(--neg)";
}

export default function ReportPanel({ api }) {
  const [range, setRange] = useState(weekRange());
  const [preset, setPreset] = useState("week");
  const [report, setReport] = useState(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const toast = useToast();

  async function load() {
    try { setReport(await api.get(`/admin/report?from=${range.from}&to=${range.to}`)); }
    catch { setError("حدث خطأ، حاول مرة أخرى"); }
  }
  useEffect(() => { load(); }, [range.from, range.to]);

  function pick(name, r) { setPreset(name); setRange(r); }
  function setCustom(which, value) {
    if (!value) return;
    setPreset("custom");
    setRange((cur) => ({ ...cur, [which]: which === "from" ? fromDateInput(value, false) : fromDateInput(value, true) }));
  }

  async function openDetail(emp) {
    const d = await api.get(`/admin/sessions?from=${range.from}&to=${range.to}&user_id=${emp.user_id}`);
    setDetail({ ...emp, sessions: d.sessions });
  }
  async function exportCsv() {
    try { await api.download(`/admin/export.csv?from=${range.from}&to=${range.to}`, `timeclock-${range.from}-${range.to}.csv`); toast("تم تصدير الملف"); }
    catch { setError("حدث خطأ، حاول مرة أخرى"); }
  }

  if (!report && !error) return <div className="panel muted">جارٍ التحميل…</div>;

  const employees = (report?.employees ?? []).filter((e) => !query.trim() || e.name?.includes(query.trim()));
  const target = report?.daily_target_hours ?? 8;

  return (
    <section className="panel">
      <div className="panel-h">
        <h2>التقرير</h2>
        <div className="toolbar">
          <div className="filters" role="group" aria-label="الفترة">
            <button type="button" aria-pressed={preset === "today"} onClick={() => pick("today", todayRange())}>اليوم</button>
            <button type="button" aria-pressed={preset === "week"} onClick={() => pick("week", weekRange())}>الأسبوع</button>
            <button type="button" aria-pressed={preset === "month"} onClick={() => pick("month", monthRange())}>الشهر</button>
          </div>
          <input type="date" aria-label="من" value={toDateInput(range.from)} onChange={(e) => setCustom("from", e.target.value)} />
          <input type="date" aria-label="إلى" value={toDateInput(range.to)} onChange={(e) => setCustom("to", e.target.value)} />
          <div className="search">
            <label htmlFor="empq" className="sr">بحث عن موظف</label>
            <input id="empq" type="search" placeholder="بحث عن موظف" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Icon name="search" />
          </div>
          <Button variant="ghost" size="sm" onClick={exportCsv}><Icon name="download" size={18} />تصدير CSV</Button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th scope="col">الموظف</th><th scope="col">ساعات العمل</th><th scope="col">الهدف</th>
            <th scope="col">الإنجاز</th><th scope="col">أيام الحضور</th>
            <th scope="col">أيام التأخير</th><th scope="col">مغلقة تلقائياً</th>
          </tr></thead>
          <tbody>
            {employees.length ? employees.map((e) => {
              const t = e.days_present * target;
              const workedH = Number(formatHours(e.worked_sec));
              const pct = t > 0 ? Math.round((workedH / t) * 100) : 0;
              return (
                <tr key={e.user_id} style={{ cursor: "pointer" }} onClick={() => openDetail(e)}>
                  <td><div className="who"><span className="avatar" aria-hidden="true">{(e.name || "؟").charAt(0)}</span><div className="n">{e.name}</div></div></td>
                  <td className="num">{formatHours(e.worked_sec)}</td>
                  <td className="num">{t.toFixed(2)}</td>
                  <td className="num" style={{ color: completionColor(pct) }}>{pct}%</td>
                  <td className="num">{e.days_present}</td>
                  <td className="num">{report.work_start ? e.late_days : "—"}</td>
                  <td className="num">{e.auto_closed}</td>
                </tr>
              );
            }) : <tr><td colSpan={7} className="empty">لا يوجد موظفون مطابقون.</td></tr>}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h"><h3>جلسات: {detail.name}</h3><Button variant="ghost" size="sm" onClick={() => setDetail(null)}>إغلاق</Button></div>
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">البداية</th><th scope="col">النهاية</th><th scope="col">الإغلاق</th><th scope="col"></th></tr></thead>
            <tbody>{detail.sessions.map((s) => (
              <tr key={s.id}>
                <td className="num">{new Date(s.started_at * 1000).toLocaleString("en-GB")}</td>
                <td className="num">{s.ended_at ? new Date(s.ended_at * 1000).toLocaleString("en-GB") : "مفتوحة"}</td>
                <td>{s.closed_by ?? "—"}</td>
                <td><Button variant="ghost" size="sm" onClick={() => setEditing(s)}>تعديل</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {editing && (
        <SessionEditModal api={api} session={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); toast("تم حفظ التعديل"); await load(); if (detail) await openDetail(detail); }} />
      )}

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}
