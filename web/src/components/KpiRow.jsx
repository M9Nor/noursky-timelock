export default function KpiRow({ live }) {
  const employees = live?.employees ?? [];
  const working = employees.filter((e) => e.session_id != null).length;
  return (
    <dl className="kpis" style={{ margin: 0, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
      <div className="kpi acc"><dt>داخل الدوام الآن</dt><dd>{working} <small>/ {employees.length}</small></dd></div>
      <div className="kpi"><dt>إجمالي الموظفين</dt><dd>{employees.length}</dd></div>
    </dl>
  );
}
