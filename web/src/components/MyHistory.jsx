import { useEffect, useState } from "react";
import { formatHours, formatStamp } from "../time.js";

export default function MyHistory({ api }) {
  const [sessions, setSessions] = useState(null);
  const [timezone, setTimezone] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/me/sessions?days=7")
      // Times follow the company's timezone, not whatever the device is set to.
      .then((r) => { setTimezone(r.timezone ?? null); setSessions(r.sessions); })
      .catch(() => setError("حدث خطأ، حاول مرة أخرى"));
  }, []);

  if (error) return <section className="panel my-history error">{error}</section>;
  if (!sessions) return <section className="panel my-history muted">جارٍ التحميل…</section>;

  return (
    <section className="panel my-history">
      <div className="panel-h"><h2>سجلّي — آخر 7 أيام</h2></div>
      {sessions.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th scope="col">البداية</th><th scope="col">النهاية</th><th scope="col">الساعات</th><th scope="col"></th>
            </tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="ltr">{formatStamp(s.started_at, timezone, { year: false })}</td>
                  <td className="ltr">{formatStamp(s.ended_at, timezone, { year: false })}</td>
                  <td className="num">{s.duration_sec ? formatHours(s.duration_sec - (s.break_sec ?? 0)) : "—"}</td>
                  <td>{s.closed_by === "auto" ? "أُغلقت تلقائياً" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">لا توجد جلسات في آخر 7 أيام.</p>
      )}
    </section>
  );
}
