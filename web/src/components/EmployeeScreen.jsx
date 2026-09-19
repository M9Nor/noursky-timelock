import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import { formatDuration, formatHours, serverOffset, nowWithOffset } from "../time.js";

export default function EmployeeScreen({ api }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const offsetRef = useRef(0);

  async function refresh() {
    const s = await api.get("/me/status");
    offsetRef.current = serverOffset(s.server_time);
    setStatus(s);
  }

  useEffect(() => { refresh().catch((e) => setError(e.code || "INTERNAL_ERROR")); }, []);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function toggle() {
    setLoading(true); setError("");
    try {
      await api.post(status?.open_session ? "/session/stop" : "/session/start");
      await refresh();
    } catch (e) {
      setError(e.code || "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  }

  if (!status && !error) return <div className="card muted">جارٍ التحميل…</div>;

  const open = status?.open_session;
  const liveSec = open ? nowWithOffset(offsetRef.current) - open.started_at : 0;
  const todaySec = (status?.worked_sec ?? 0) + (open ? liveSec : 0);

  return (
    <div className="card" style={{ textAlign: "center", maxWidth: 420, margin: "40px auto" }}>
      <div style={{ fontSize: "2.4rem", fontWeight: 700, margin: "12px 0" }}>
        {open ? formatDuration(liveSec) : "0:00:00"}
      </div>
      <Button onClick={toggle} loading={loading} variant={open ? "stop" : "start"}>
        {open ? "إنهاء الدوام" : "ابدأ الدوام"}
      </Button>
      <div className="muted" style={{ marginTop: 16 }}>
        مجموع اليوم: {formatHours(todaySec)} ساعة
      </div>
      {error && <div className="error" style={{ marginTop: 12 }}>حدث خطأ، حاول مرة أخرى</div>}
    </div>
  );
}
