import { useEffect, useRef, useState } from "react";
import KpiRow from "./KpiRow.jsx";
import { useI18n } from "../i18n.jsx";
import { usePolling } from "../usePolling.js";
import { formatDuration, formatIdle, serverOffset, nowWithOffset } from "../time.js";

export default function LiveFloor({ api }) {
  const { t, locale } = useI18n();
  const initials = (n) => (n || t("live.unknownInitial")).trim().charAt(0);
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
    const tick = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(tick);
  }, []);
  usePolling(refresh, 30000);

  if (!data) return <div className="panel muted">{t("common.loading")}</div>;
  const nowS = nowWithOffset(offsetRef.current);
  const fb = data.fixed_break;
  const inFixed = Boolean(fb && nowS >= fb.starts_at && nowS < fb.ends_at);
  // idle_sec is exact at server_time; it keeps growing between polls unless on a break.
  const idleNow = (p) => (p.idle_sec == null ? null : p.idle_sec + (p.break_started_at || inFixed ? 0 : Math.max(0, nowS - data.server_time)));
  const isIdle = (p) => data.idle_minutes != null && idleNow(p) != null && idleNow(p) >= data.idle_minutes * 60;
  const working = data.employees.filter((e) => e.session_id != null);
  const offline = data.employees.filter((e) => e.session_id == null);
  const lane = (label, people, live) => (
    <div className="lane" aria-label={`${label}: ${people.length}`}>
      <div className="lane-h"><span>{label}</span><b>{people.length}</b></div>
      {people.length ? people.map((p) => (
        <div className="person" key={p.user_id}>
          <span className="avatar" aria-hidden="true">{initials(p.name)}</span>
          <div style={{ minWidth: 0 }}>
            <div className="n">{p.name}</div>
            {live && (p.break_started_at
              ? <div className="m break">{t("live.break", { dur: formatDuration(nowS - p.break_started_at) })}</div>
              : inFixed
                ? <div className="m break">{t("live.breakTime")}</div>
                : <div className="m">{formatDuration(nowS - p.started_at)}</div>)}
            {live && !p.break_started_at && !inFixed && isIdle(p) && (
              <div className="m warn">{t("live.idle", { dur: formatIdle(idleNow(p), locale) })}</div>
            )}
            {!live && p.active_without_session && <div className="m warn">{t("live.activeNoSession")}</div>}
          </div>
        </div>
      )) : <div className="hint" style={{ textAlign: "center", padding: "12px 0" }}>{t("live.none")}</div>}
    </div>
  );

  return (
    <>
      <KpiRow live={data} />
      <section className="panel">
        <div className="panel-h"><h2>{t("live.team")}</h2></div>
        <div className="floor">
          {lane(t("live.working"), working, true)}
          {lane(t("live.offline"), offline, false)}
        </div>
      </section>
    </>
  );
}
