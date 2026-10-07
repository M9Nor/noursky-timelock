import { useEffect, useState } from "react";
import { formatStamp, formatTime } from "../time.js";
import { useI18n } from "../i18n.jsx";

// The employee's own early-leave requests of the last 30 days (spec 2026-10-07 §5). Hidden
// while there are none; reloads with the employee screen (`reloadKey`).
export default function MyEarlyLeave({ api, reloadKey = 0 }) {
  const { t } = useI18n();
  const [data, setData] = useState({ requests: [], timezone: null });

  useEffect(() => {
    api.get("/me/early-leave?days=30")
      .then((r) => setData({ requests: Array.isArray(r?.requests) ? r.requests : [], timezone: r?.timezone ?? null }))
      .catch(() => {});
  }, [reloadKey]);

  if (!data.requests.length) return null;
  const tz = data.timezone;
  return (
    <section className="panel my-early-leave">
      <div className="panel-h"><h2>{t("earlyLeave.mineTitle")}</h2></div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{t("earlyLeave.colDate")}</th><th>{t("earlyLeave.colReason")}</th>
            <th>{t("earlyLeave.colStatus")}</th><th>{t("earlyLeave.colAnswer")}</th>
          </tr></thead>
          <tbody>
            {data.requests.map((r) => (
              <tr key={r.id}>
                <td className="ltr">{formatStamp(r.requested_at, tz)}</td>
                <td>{r.reason}</td>
                <td>{t(`earlyLeave.status.${r.status}`)}</td>
                <td>
                  {r.decided_by_name && r.decided_at != null && (
                    <div>{t("earlyLeave.answeredBy", { name: r.decided_by_name, time: formatTime(r.decided_at, tz) })}</div>
                  )}
                  {r.manager_note && <div className="muted">{r.manager_note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
