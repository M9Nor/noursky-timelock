import { useState } from "react";
import LivePanel from "./LivePanel.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const TABS = [
  { key: "live", label: "شغّال الآن" },
  { key: "report", label: "التقرير" },
  { key: "settings", label: "الإعدادات" },
];

export default function ManagerDashboard({ api }) {
  const [tab, setTab] = useState("live");
  return (
    <div style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key} className="btn"
            style={{ background: tab === t.key ? "var(--accent)" : "var(--muted)" }}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === "live" && <LivePanel api={api} />}
      {tab === "report" && <ReportPanel api={api} />}
      {tab === "settings" && <SettingsPanel api={api} />}
    </div>
  );
}
