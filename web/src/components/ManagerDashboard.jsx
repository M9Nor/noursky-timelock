import LiveFloor from "./LiveFloor.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

export default function ManagerDashboard({ api }) {
  return (
    <div className="grid">
      <LiveFloor api={api} />
      <ReportPanel api={api} />
      <SettingsPanel api={api} />
    </div>
  );
}
