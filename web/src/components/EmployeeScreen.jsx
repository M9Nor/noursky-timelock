import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatClock, formatHours, serverOffset, nowWithOffset, liveTotals } from "../time.js";
import MyHistory from "./MyHistory.jsx";
import StopNoteDialog from "./StopNoteDialog.jsx";

const GENERIC_ERROR = "حدث خطأ، حاول مرة أخرى";
// Specific, actionable messages for error codes the employee can act on directly,
// instead of the generic banner. Any other code falls back to GENERIC_ERROR.
const ERROR_MESSAGES = {
  BREAKS_DISABLED: "الاستراحات غير مفعّلة",
  NO_OPEN_BREAK: "لا توجد استراحة مفتوحة",
};

export default function EmployeeScreen({ api, user }) {
  const [status, setStatus] = useState(null);
  const [weekSec, setWeekSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [noteError, setNoteError] = useState("");
  const [, setTick] = useState(0);
  const [targetSec, setTargetSec] = useState(8 * 3600);
  const [policy, setPolicy] = useState({ break_mode: "off", break_start: null, break_end: null, break_paid: false, note_on_stop: "off" });
  const [askNote, setAskNote] = useState(false);
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

  useEffect(() => { refresh().catch(() => setError(GENERIC_ERROR)); }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.get("/me/settings");
        setTargetSec(Number(cfg.daily_target_hours) * 3600);
        setPolicy({
          // Older API responses only carry breaks_enabled.
          break_mode: cfg.break_mode ?? (cfg.breaks_enabled ? "flexible" : "off"),
          break_start: cfg.break_start ?? null,
          break_end: cfg.break_end ?? null,
          break_paid: Boolean(cfg.break_paid),
          note_on_stop: cfg.note_on_stop ?? "off",
        });
      } catch {
        // Settings are a convenience here: fall back to an 8-hour target, no break
        // button and no note prompt. The server still enforces a required note.
      }
    })();
  }, [api]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // `dialog: true` routes errors into the note dialog's own `.err` span (via noteError)
  // instead of the page banner behind it, since the dialog overlay hides the banner.
  async function run(action, message, { dialog = false } = {}) {
    setLoading(true);
    if (dialog) setNoteError(""); else setError("");
    try {
      await action();
      await refresh();
      toast(message);
      return true;
    } catch (e) {
      if (e.code === "NOTE_REQUIRED") {
        // Our copy of the policy was stale or failed to load; the server is the authority.
        setPolicy((p) => ({ ...p, note_on_stop: "required" }));
        setAskNote(true);
        return false;
      }
      if (e.code === "NO_OPEN_SESSION") {
        // The session is already gone (auto-closed overnight, stopped from another tab,
        // etc). Nothing to confirm anymore — close the dialog if open and resync the
        // screen with the server instead of leaving it stuck showing "clocked in".
        setAskNote(false);
        setNoteError("");
        await refresh().catch(() => {});
        return false;
      }
      const mapped = ERROR_MESSAGES[e.code];
      if (mapped) {
        if (dialog) setNoteError(mapped); else setError(mapped);
        // Resync so button state (e.g. the break button) catches up with the server.
        await refresh().catch(() => {});
        return false;
      }
      if (dialog) setNoteError(GENERIC_ERROR); else setError(GENERIC_ERROR);
      return false;
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!status?.open_session) return run(() => api.post("/session/start"), "بدأ دوامك");
    if (policy.note_on_stop !== "off") { setNoteError(""); setAskNote(true); return undefined; }
    return run(() => api.post("/session/stop"), "انتهى دوامك");
  }

  async function stopWithNote(note) {
    const ok = await run(() => api.post("/session/stop", note ? { note } : {}), "انتهى دوامك", { dialog: true });
    if (ok) setAskNote(false);
  }

  function toggleBreak() {
    return status?.open_break
      ? run(() => api.post("/session/break/stop"), "انتهت الاستراحة")
      : run(() => api.post("/session/break/start"), "بدأت الاستراحة");
  }

  if (!status && !error) return <div className="panel muted">جارٍ التحميل…</div>;

  const open = status?.open_session;
  const { sessionSec, todaySec, onBreak, inFixed } = liveTotals(status, nowWithOffset(offsetRef.current));
  const clock = formatClock(sessionSec);
  const remain = Math.max(0, targetSec - todaySec);
  const pct = Math.min(100, (todaySec / targetSec) * 100);
  const name = user?.name || "";
  const [chipClass, chipText] = onBreak ? ["break", "في استراحة"]
    : inFixed ? ["break", "وقت الاستراحة"]
    : open ? ["work", "داخل الدوام"] : ["off", "لم يسجّل الدخول"];
  // An employee already on a break can always end it, even if the mode changed since.
  const showBreak = open && (policy.break_mode === "flexible" || onBreak);

  return (
    <div className="grid emp">
      <div className="hero">
        <div>
          <div className="hero-top">
            <span className="hello">مرحباً{name ? `، ${name}` : ""}</span>
            <span className={`chip ${chipClass}`}>{chipText}</span>
          </div>
          <div className="timer" aria-live="off">{clock.h}:{clock.mm}<span className="sec">:{clock.ss}</span></div>
          <div className="hero-meta">
            <div>ساعات اليوم المطلوبة<strong className="ltr">{formatHours(targetSec)}</strong></div>
            <div>المتبقي<strong className="ltr">{remain > 0 ? formatHours(remain) : "اكتملت"}</strong></div>
            <div>مجموع اليوم<strong className="ltr">{formatHours(todaySec)}</strong></div>
          </div>
          <div className="goal" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <i style={{ width: pct + "%" }} />
          </div>
          {policy.break_mode === "fixed" && policy.break_start && policy.break_end && (
            <p className="hint">الاستراحة <span className="ltr">{policy.break_start}–{policy.break_end}</span> · {policy.break_paid ? "مدفوعة" : "غير مدفوعة"}</p>
          )}
        </div>
        <div className="actions">
          <Button onClick={toggle} loading={loading} variant={open ? "danger" : "primary"} size="lg">
            <Icon name={open ? "stop" : "play"} />{open ? "إنهاء الدوام" : "بدء الدوام"}
          </Button>
          {showBreak && (
            <Button onClick={toggleBreak} loading={loading} variant="ghost" size="lg">
              <Icon name={onBreak ? "play" : "pause"} />{onBreak ? "إنهاء الاستراحة" : "استراحة"}
            </Button>
          )}
        </div>
      </div>

      <section className="panel">
        <div className="panel-h"><h2>ساعاتي هذا الأسبوع</h2></div>
        <p className="hero-meta"><span>المجموع<strong className="ltr">{formatHours(weekSec)}</strong></span></p>
      </section>

      <MyHistory api={api} />

      {askNote && (
        <StopNoteDialog required={policy.note_on_stop === "required"} loading={loading} error={noteError}
          onConfirm={stopWithNote} onCancel={() => { setAskNote(false); setNoteError(""); }} />
      )}

      {error && <div className="panel error">{error}</div>}
    </div>
  );
}
