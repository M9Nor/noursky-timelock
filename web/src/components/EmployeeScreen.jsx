import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatClock, formatHours, formatIdle, formatTime, serverOffset, nowWithOffset, liveTotals } from "../time.js";
import MyHistory from "./MyHistory.jsx";
import StopNoteDialog from "./StopNoteDialog.jsx";
import { useAlertTitle } from "../alertTitle.js";
import { useI18n } from "../i18n.jsx";

// Error state holds dictionary keys (not text) so a message follows a language switch.
const GENERIC_ERROR = "err.generic";
// Error codes the employee can act on directly get their own message (`err.<CODE>`)
// instead of the generic banner. Any other code falls back to GENERIC_ERROR.
const SPECIFIC_ERRORS = new Set(["BREAKS_DISABLED", "NO_OPEN_BREAK"]);

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
  const [alerts, setAlerts] = useState({ list: [], timezone: null, serverTime: null });
  const [alertNote, setAlertNote] = useState("");
  const [alertNoteError, setAlertNoteError] = useState("");
  const [sendingNote, setSendingNote] = useState(false);
  const offsetRef = useRef(0);
  const toast = useToast();
  const { t, locale } = useI18n();

  async function refresh() {
    const s = await api.get("/me/status");
    offsetRef.current = serverOffset(s.server_time);
    setStatus(s);
    const weekFrom = s.server_time - 7 * 86400;
    const wk = await api.get(`/me/status?since=${weekFrom}`);
    setWeekSec(wk.worked_sec);
    // Alerts are a convenience: a failure here never blocks clocking in.
    try {
      const a = await api.get("/me/alerts");
      setAlerts({ list: a.alerts ?? [], timezone: a.timezone ?? null, serverTime: a.server_time ?? null });
    } catch {
      setAlerts({ list: [], timezone: null, serverTime: null });
    }
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

  // Alerts appear without a reload: the screen re-reads status and alerts every minute.
  useEffect(() => {
    const id = setInterval(() => refresh().catch(() => {}), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // "Today" starts over at local midnight: reload then, so the totals and today's fixed
  // window belong to the new day instead of extrapolating yesterday's.
  useEffect(() => {
    if (!status?.day_ends_at) return undefined;
    const ms = Math.max(0, status.day_ends_at - nowWithOffset(offsetRef.current)) * 1000 + 1000;
    const id = setTimeout(() => refresh().catch(() => {}), ms);
    return () => clearTimeout(id);
  }, [status?.day_ends_at]);

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
      const mapped = SPECIFIC_ERRORS.has(e.code) ? `err.${e.code}` : null;
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
    if (!status?.open_session) return run(() => api.post("/session/start"), t("employee.toastStarted"));
    if (policy.note_on_stop !== "off") { setNoteError(""); setAskNote(true); return undefined; }
    return run(() => api.post("/session/stop"), t("employee.toastStopped"));
  }

  async function stopWithNote(note) {
    const ok = await run(() => api.post("/session/stop", note ? { note } : {}), t("employee.toastStopped"), { dialog: true });
    if (ok) setAskNote(false);
  }

  async function sendAlertNote(id) {
    const note = alertNote.trim();
    if (!note || sendingNote) return;
    setAlertNoteError("");
    setSendingNote(true);
    try {
      await api.post(`/me/alerts/${id}/note`, { note });
      setAlertNote("");
      toast(t("employee.noteSent"));
    } catch (e) {
      setAlertNoteError(e.code === "NOTE_TOO_LONG" ? "err.NOTE_TOO_LONG" : GENERIC_ERROR);
    } finally {
      setSendingNote(false);
    }
  }

  function toggleBreak() {
    return status?.open_break
      ? run(() => api.post("/session/break/stop"), t("employee.toastBreakEnded"))
      : run(() => api.post("/session/break/start"), t("employee.toastBreakStarted"));
  }

  // Computed before the loading early-return so hook order never changes between renders.
  const open = status?.open_session;
  const nci = !open ? alerts.list.find((a) => a.kind === "working_not_clocked_in") : null;
  const idle = open ? alerts.list.find((a) => a.kind === "idle" && a.to_at == null) : null;
  useAlertTitle(Boolean(nci || idle));

  if (!status && !error) return <div className="panel muted">{t("employee.loading")}</div>;

  const { sessionSec, todaySec, onBreak, inFixed } = liveTotals(status, nowWithOffset(offsetRef.current));
  const clock = formatClock(sessionSec);
  const remain = Math.max(0, targetSec - todaySec);
  const pct = Math.min(100, (todaySec / targetSec) * 100);
  const name = user?.name || "";
  const [chipClass, chipText] = onBreak ? ["break", t("employee.chipBreak")]
    : inFixed ? ["break", t("employee.chipBreakTime")]
    : open ? ["work", t("employee.chipWork")] : ["off", t("employee.chipOff")];
  // An employee already on a break can always end it, even if the mode changed since.
  const showBreak = open && (policy.break_mode === "flexible" || onBreak);

  const noteBox = (id) => (
    <>
      <div className="field">
        <label htmlFor="alert-note">{t("employee.noteLabel")}</label>
        <textarea id="alert-note" maxLength={300} value={alertNote} onChange={(e) => setAlertNote(e.target.value)} />
        {alertNoteError && <span className="err">{t(alertNoteError)}</span>}
      </div>
      <Button variant="ghost" size="sm" disabled={!alertNote.trim() || sendingNote} onClick={() => sendAlertNote(id)}>{t("employee.noteSend")}</Button>
    </>
  );

  return (
    <div className="grid emp">
      <div className="hero">
        <div>
          <div className="hero-top">
            <span className="hello">{name ? t("employee.helloName", { name }) : t("employee.hello")}</span>
            <span className={`chip ${chipClass}`}>{chipText}</span>
          </div>
          <div className="timer" aria-live="off">{clock.h}:{clock.mm}<span className="sec">:{clock.ss}</span></div>
          <div className="hero-meta">
            <div>{t("employee.target")}<strong className="ltr">{formatHours(targetSec)}</strong></div>
            <div>{t("employee.remaining")}<strong className="ltr">{remain > 0 ? formatHours(remain) : t("employee.done")}</strong></div>
            <div>{t("employee.todayTotal")}<strong className="ltr">{formatHours(todaySec)}</strong></div>
          </div>
          <div className="goal" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <i style={{ width: pct + "%" }} />
          </div>
          {policy.break_mode === "fixed" && policy.break_start && policy.break_end && (
            <p className="hint">{t("employee.breakWindow")} <span className="ltr">{policy.break_start}–{policy.break_end}</span> · {policy.break_paid ? t("employee.breakPaid") : t("employee.breakUnpaid")}</p>
          )}
          {status?.activity_monitoring && <p className="hint">{t("employee.monitoring")}</p>}
        </div>
        <div className="actions">
          <Button onClick={toggle} loading={loading} variant={open ? "danger" : "primary"} size="lg">
            <Icon name={open ? "stop" : "play"} />{open ? t("employee.clockOut") : t("employee.clockIn")}
          </Button>
          {showBreak && (
            <Button onClick={toggleBreak} loading={loading} variant="ghost" size="lg">
              <Icon name={onBreak ? "play" : "pause"} />{onBreak ? t("employee.breakEnd") : t("employee.breakStart")}
            </Button>
          )}
        </div>
      </div>

      {nci && (
        <section className="panel notice" role="status">
          <p>{t("employee.notClockedInBanner", { time: formatTime(nci.from_at, alerts.timezone) })}</p>
          <div className="actions">
            <Button onClick={toggle} loading={loading} size="lg"><Icon name="play" />{t("employee.clockIn")}</Button>
          </div>
          {noteBox(nci.id)}
        </section>
      )}

      {idle && (
        <section className="panel notice" role="status">
          <p>{t("employee.idleBanner", {
            time: formatTime(idle.from_at, alerts.timezone),
            dur: formatIdle(Math.max(0, (alerts.serverTime ?? idle.from_at) - idle.from_at), locale),
          })}</p>
          {noteBox(idle.id)}
        </section>
      )}

      <section className="panel">
        <div className="panel-h"><h2>{t("employee.weekTitle")}</h2></div>
        <p className="hero-meta"><span>{t("employee.weekTotal")}<strong className="ltr">{formatHours(weekSec)}</strong></span></p>
      </section>

      <MyHistory api={api} />

      {askNote && (
        <StopNoteDialog required={policy.note_on_stop === "required"} loading={loading} error={noteError ? t(noteError) : ""}
          onConfirm={stopWithNote} onCancel={() => { setAskNote(false); setNoteError(""); }} />
      )}

      {error && <div className="panel error">{t(error)}</div>}
    </div>
  );
}
