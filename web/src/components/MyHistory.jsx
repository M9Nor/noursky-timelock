import { useEffect, useState } from "react";
import { formatHours, formatStamp } from "../time.js";
import { useI18n } from "../i18n.jsx";

// `reloadKey` changes whenever the employee screen re-reads its data (every poll, and after
// clocking in or out), so the list does not wait for a page reload.
export default function MyHistory({ api, reloadKey = 0 }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState(null);
  const [timezone, setTimezone] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get("/me/sessions?days=7")
      // Times follow the company's timezone, not whatever the device is set to.
      .then((r) => { setTimezone(r.timezone ?? null); setSessions(r.sessions); })
      .catch(() => setError(true));
  }, [reloadKey]);

  if (error) return <section className="panel my-history error">{t("err.generic")}</section>;
  if (!sessions) return <section className="panel my-history muted">{t("history.loading")}</section>;

  return (
    <section className="panel my-history">
      <div className="panel-h"><h2>{t("history.title")}</h2></div>
      {sessions.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">{t("history.colStart")}</th><th scope="col">{t("history.colEnd")}</th><th scope="col">{t("history.colHours")}</th><th scope="col"></th>
            </tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="ltr">{formatStamp(s.started_at, timezone, { year: false })}</td>
                  <td className="ltr">{formatStamp(s.ended_at, timezone, { year: false })}</td>
                  <td className="num">{s.duration_sec ? formatHours(s.duration_sec - (s.break_sec ?? 0)) : "—"}</td>
                  <td>{s.closed_by === "auto" ? t("history.autoClosed") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">{t("history.empty")}</p>
      )}
    </section>
  );
}
