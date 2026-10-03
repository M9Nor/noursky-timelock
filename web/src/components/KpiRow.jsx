import { useI18n } from "../i18n.jsx";

export default function KpiRow({ live }) {
  const { t } = useI18n();
  const employees = live?.employees ?? [];
  const working = employees.filter((e) => e.session_id != null).length;
  return (
    <dl className="kpis" style={{ margin: 0, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
      <div className="kpi acc"><dt>{t("kpi.working")}</dt><dd>{working} <small>/ {employees.length}</small></dd></div>
      <div className="kpi"><dt>{t("kpi.total")}</dt><dd>{employees.length}</dd></div>
    </dl>
  );
}
