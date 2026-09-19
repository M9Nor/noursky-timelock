import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatClock, formatHours, serverOffset, nowWithOffset } from "../time.js";

const DAILY_TARGET_SEC = 8 * 3600; // employee has no settings route; spec §7 default

export default function EmployeeScreen({ api, user }) {
  const [status, setStatus] = useState(null);
  const [weekSec, setWeekSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);
  const offsetRef = useRef(0);
  const toast = useToast();

  async function refresh() {
    const s = await api.get("/me/status");
    offsetRef.current = serverOffset(s.server_time);
    setStatus(s);
    const weekFrom = s.server_time - 7 * 86400;
    const wk = await api.get(`/me/status?since=${weekFrom}`);
    setWeekSec(wk.worked_sec);
  }

  useEffect(() => { refresh().catch((e) => setError(e.code || "INTERNAL_ERROR")); }, []);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function toggle() {
    setLoading(true); setError("");
    const opening = !status?.open_session;
    try {
      await api.post(opening ? "/session/start" : "/session/stop");
      await refresh();
      toast(opening ? "بدأ دوامك" : "انتهى دوامك");
    } catch (e) {
      setError(e.code || "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  }

  if (!status && !error) return <div className="panel muted">جارٍ التحميل…</div>;

  const open = status?.open_session;
  const liveSec = open ? nowWithOffset(offsetRef.current) - open.started_at : 0;
  const todaySec = (status?.worked_sec ?? 0) + (open ? liveSec : 0);
  const clock = formatClock(open ? liveSec : 0);
  const remain = Math.max(0, DAILY_TARGET_SEC - todaySec);
  const pct = Math.min(100, (todaySec / DAILY_TARGET_SEC) * 100);
  const name = user?.name || "";

  return (
    <div className="grid emp">
      <div className="hero">
        <div>
          <div className="hero-top">
            <span className="hello">مرحباً{name ? `، ${name}` : ""}</span>
            <span className={`chip ${open ? "work" : "off"}`}>{open ? "داخل الدوام" : "لم يسجّل الدخول"}</span>
          </div>
          <div className="timer" aria-live="off">{clock.h}:{clock.mm}<span className="sec">:{clock.ss}</span></div>
          <div className="hero-meta">
            <div>ساعات اليوم المطلوبة<strong className="ltr">{formatHours(DAILY_TARGET_SEC)}</strong></div>
            <div>المتبقي<strong className="ltr">{remain > 0 ? formatHours(remain) : "اكتملت"}</strong></div>
            <div>مجموع اليوم<strong className="ltr">{formatHours(todaySec)}</strong></div>
          </div>
          <div className="goal" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <i style={{ width: pct + "%" }} />
          </div>
        </div>
        <div className="actions">
          <Button onClick={toggle} loading={loading} variant={open ? "danger" : "primary"} size="lg">
            <Icon name={open ? "stop" : "play"} />{open ? "إنهاء الدوام" : "بدء الدوام"}
          </Button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-h"><h2>ساعاتي هذا الأسبوع</h2></div>
        <p className="hero-meta"><span>المجموع<strong className="ltr">{formatHours(weekSec)}</strong></span></p>
      </section>

      {error && <div className="panel error">حدث خطأ، حاول مرة أخرى</div>}
    </div>
  );
}
