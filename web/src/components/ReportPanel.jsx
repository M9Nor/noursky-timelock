import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatHours, formatLateness, formatStamp, formatBreak, formatIdle } from "../time.js";
import SessionEditModal from "./SessionEditModal.jsx";
import { useI18n } from "../i18n.jsx";
import { usePolling } from "../usePolling.js";

export function todayRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 86400, to }; }
export function weekRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 7 * 86400, to }; }
export function monthRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 30 * 86400, to }; }
const PRESET_RANGES = { today: todayRange, week: weekRange, month: monthRange };

const CLOSED_BY = new Set(["user", "auto", "admin"]);

const toDateInput = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const fromDateInput = (v, endOfDay) => Math.floor(new Date(v + (endOfDay ? "T23:59:59" : "T00:00:00")).getTime() / 1000);

function completionColor(pct) {
  if (pct >= 90) return "var(--pos)";
  if (pct >= 60) return "var(--warn)";
  return "var(--neg)";
}

export default function ReportPanel({ api }) {
  const { t, locale } = useI18n();
  // Codes the server writes get a translated name; anything else shows as stored.
  const closedByLabel = (code) => (CLOSED_BY.has(code) ? t(`report.closedBy.${code}`) : code);
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
    catch { setError("err.generic"); }
  }
  useEffect(() => { load(); }, [range.from, range.to]);
  // A preset ends "now", so a re-read moves its end forward (the effect above loads it);
  // custom dates are re-read as they are.
  usePolling(async () => {
    if (PRESET_RANGES[preset]) setRange(PRESET_RANGES[preset]());
    else await load();
  }, 60000);

  function pick(name, r) { setPreset(name); setRange(r); }
  function setCustom(which, value) {
    if (!value) return;
    setPreset("custom");
    setRange((cur) => ({ ...cur, [which]: which === "from" ? fromDateInput(value, false) : fromDateInput(value, true) }));
  }

  async function openDetail(emp) {
    const d = await api.get(`/admin/sessions?from=${range.from}&to=${range.to}&user_id=${emp.user_id}`);
    // The endpoint reports the location's own timezone; the browser's may differ.
    setDetail({ ...emp, sessions: d.sessions, timezone: d.timezone ?? report?.timezone });
  }
  async function exportCsv() {
    try { await api.download(`/admin/export.csv?from=${range.from}&to=${range.to}`, `timeclock-${range.from}-${range.to}.csv`); toast(t("report.exported")); }
    catch { setError("err.generic"); }
  }

  if (!report && !error) return <div className="panel muted">{t("common.loading")}</div>;

  const employees = (report?.employees ?? []).filter((e) => !query.trim() || e.name?.includes(query.trim()));
  const target = report?.daily_target_hours ?? 8;

  return (
    <section className="panel">
      <div className="panel-h">
        <h2>{t("report.title")}</h2>
        <div className="toolbar">
          <div className="filters" role="group" aria-label={t("report.period")}>
            <button type="button" aria-pressed={preset === "today"} onClick={() => pick("today", todayRange())}>{t("report.today")}</button>
            <button type="button" aria-pressed={preset === "week"} onClick={() => pick("week", weekRange())}>{t("report.week")}</button>
            <button type="button" aria-pressed={preset === "month"} onClick={() => pick("month", monthRange())}>{t("report.month")}</button>
          </div>
          <input type="date" aria-label={t("report.from")} value={toDateInput(range.from)} onChange={(e) => setCustom("from", e.target.value)} />
          <input type="date" aria-label={t("report.to")} value={toDateInput(range.to)} onChange={(e) => setCustom("to", e.target.value)} />
          <div className="search">
            <label htmlFor="empq" className="sr">{t("report.search")}</label>
            <input id="empq" type="search" placeholder={t("report.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
            <Icon name="search" />
          </div>
          <Button variant="ghost" size="sm" onClick={exportCsv}><Icon name="download" size={18} />{t("report.export")}</Button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th scope="col">{t("report.colEmployee")}</th><th scope="col">{t("report.colHours")}</th><th scope="col">{t("report.colTarget")}</th>
            <th scope="col">{t("report.colCompletion")}</th><th scope="col">{t("report.colDaysPresent")}</th>
            <th scope="col">{t("report.colLateDays")}</th><th scope="col">{t("report.colAutoClosed")}</th>
          </tr></thead>
          <tbody>
            {employees.length ? employees.map((e) => {
              const targetH = e.days_present * target;
              const workedH = Number(formatHours(e.worked_sec));
              const pct = targetH > 0 ? Math.round((workedH / targetH) * 100) : 0;
              return (
                <tr key={e.user_id} style={{ cursor: "pointer" }} onClick={() => openDetail(e)}>
                  <td><div className="who"><span className="avatar" aria-hidden="true">{(e.name || t("live.unknownInitial")).charAt(0)}</span><div className="n">{e.name}</div></div></td>
                  <td className="num">{formatHours(e.worked_sec)}</td>
                  <td className="num">{targetH.toFixed(2)}</td>
                  <td className="num" style={{ color: completionColor(pct) }}>{pct}%</td>
                  <td className="num">{e.days_present}</td>
                  <td className="num">{report.work_start ? e.late_days : "—"}</td>
                  <td className="num">{e.auto_closed}</td>
                </tr>
              );
            }) : <tr><td colSpan={7} className="empty">{t("report.empty")}</td></tr>}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h"><h3>{t("report.sessionsOf", { name: detail.name })}</h3><Button variant="ghost" size="sm" onClick={() => setDetail(null)}>{t("report.close")}</Button></div>
          <div className="table-wrap"><table>
            <thead><tr>
              <th scope="col">{t("report.colStart")}</th><th scope="col">{t("report.colEnd")}</th>
              <th scope="col">{t("report.colBreak")}</th><th scope="col">{t("report.colLate")}</th><th scope="col">{t("report.colActivity")}</th><th scope="col">{t("report.colLongestIdle")}</th>
              <th scope="col">{t("report.colClosedBy")}</th><th scope="col">{t("report.colNote")}</th><th scope="col"></th>
            </tr></thead>
            <tbody>{detail.sessions.map((s) => (
              <tr key={s.id}>
                <td className="ltr">{formatStamp(s.started_at, detail.timezone)}</td>
                <td className="ltr">{s.ended_at ? formatStamp(s.ended_at, detail.timezone) : t("report.open")}</td>
                <td>{formatBreak(s.break_sec, locale) || "—"}</td>
                <td className="late">{formatLateness(s.late_by_sec, locale)}</td>
                <td className="num">{s.activity_count ?? "—"}</td>
                <td>{formatIdle(s.longest_idle_sec, locale)}</td>
                <td>{s.closed_by ? closedByLabel(s.closed_by) : "—"}</td>
                <td className="note">{s.note || "—"}</td>
                <td><Button variant="ghost" size="sm" onClick={() => setEditing(s)}>{t("report.edit")}</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {editing && (
        <SessionEditModal api={api} session={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); toast(t("report.editSaved")); await load(); if (detail) await openDetail(detail); }} />
      )}

      {error && <div className="error" style={{ marginTop: 8 }}>{t(error)}</div>}
    </section>
  );
}
