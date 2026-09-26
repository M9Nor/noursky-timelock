import { useEffect, useState } from "react";
import { formatHours } from "../time.js";

const fmt = (ts) =>
  ts
    ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        .format(new Date(Number(ts) * 1000))
    : "—";

export default function MyHistory({ api }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/me/sessions?days=7")
      .then((r) => setSessions(r.sessions))
      .catch(() => setError("حدث خطأ، حاول مرة أخرى"));
  }, []);

  if (error) return <section className="panel error">{error}</section>;
  if (!sessions) return <section className="panel muted">جارٍ التحميل…</section>;

  return (
    <section className="panel">
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
                  <td className="ltr">{fmt(s.started_at)}</td>
                  <td className="ltr">{fmt(s.ended_at)}</td>
                  <td className="num">{s.duration_sec ? formatHours(s.duration_sec) : "—"}</td>
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
