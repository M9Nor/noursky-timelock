import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatStamp } from "../time.js";
import { useI18n } from "../i18n.jsx";

// Saturday first, as the week reads in the region; bit = JavaScript getDay() (0 = Sunday).
const WEEK = [6, 0, 1, 2, 3, 4, 5];

// Validation codes the settings form shows with their own message (`err.<CODE>`); anything else is generic.
const SPECIFIC_ERRORS = new Set([
  "INVALID_TIMEZONE", "INVALID_HOURS", "INVALID_WORK_START", "INVALID_WORK_END", "INVALID_WORK_DAYS", "INVALID_GRACE",
  "INVALID_BREAKS", "INVALID_BREAK_MODE", "INVALID_BREAK_WINDOW", "INVALID_IDLE_MINUTES", "INVALID_ACTIVITY_MONITORING",
  "INVALID_NOTE_POLICY", "INVALID_LOCALE",
]);

export default function SettingsPanel({ api }) {
  const { t } = useI18n();
  const [s, setS] = useState(null);
  const [error, setError] = useState("");
  const [conn, setConn] = useState(null);
  const [connFailed, setConnFailed] = useState(false);
  const toast = useToast();

  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => setError("err.generic")); }, []);
  // The connection status is informative only; a failure never blocks the settings form.
  useEffect(() => { api.get("/admin/ghl-connection").then(setConn).catch(() => setConnFailed(true)); }, []);
  if (!s && !error) return <div className="panel muted">{t("common.loading")}</div>;
  if (!s) return <div className="panel error">{t("err.generic")}</div>;

  // last_event_at outlives an uninstall, so it only feeds the sub-text, never "connected".
  const connected = Boolean(conn && conn.installed && (conn.has_activity_scope || conn.events_24h > 0));
  const connectionText = connFailed || (!conn && s)
    ? (connFailed ? t("settings.connFailed") : t("settings.connChecking"))
    : connected
      ? t("settings.connected", {
        detail: (conn.last_event_at != null
          ? t("settings.lastEvent", { time: formatStamp(conn.last_event_at, s.timezone) })
          : t("settings.noEvents"))
          + (s.activity_monitoring ? ` · ${t("settings.events24", { n: conn.events_24h ?? 0 })}` : ""),
      })
      : t("settings.notConnected");

  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  async function save() {
    setError("");
    try {
      const saved = await api.put("/admin/settings", {
        timezone: s.timezone,
        daily_target_hours: Number(s.daily_target_hours),
        max_session_hours: Number(s.max_session_hours),
        work_start: s.work_start || null,
        work_end: s.work_end || null,
        work_days: s.work_days ?? 127,
        // An emptied field is "" — Number("") is 0, which would silently mean
        // "late one second after work_start". Treat empty/absent as the default.
        late_grace_minutes: s.late_grace_minutes === "" || s.late_grace_minutes == null
          ? 15
          : Number(s.late_grace_minutes),
        break_mode: s.break_mode ?? "off",
        break_start: s.break_start || null,
        break_end: s.break_end || null,
        break_paid: Boolean(s.break_paid),
        note_on_stop: s.note_on_stop ?? "off",
        activity_monitoring: Boolean(s.activity_monitoring),
        // Same empty-field rule as the grace: an emptied field means the default.
        idle_minutes: s.idle_minutes === "" || s.idle_minutes == null ? 30 : Number(s.idle_minutes),
        locale: s.locale ?? "ar",
      });
      setS(saved); toast(t("settings.saved"));
    } catch (e) {
      setError(SPECIFIC_ERRORS.has(e.code) ? `err.${e.code}` : "err.generic");
    }
  }

  return (
    <section className="panel" style={{ maxWidth: 480 }}>
      <div className="panel-h"><h2>{t("settings.title")}</h2></div>
      <div className="field"><label>{t("settings.timezone")}</label><input value={s.timezone} onChange={set("timezone")} /></div>
      <div className="field"><label>{t("settings.dailyTarget")}</label><input type="number" step="0.5" value={s.daily_target_hours} onChange={set("daily_target_hours")} /></div>
      <div className="field"><label>{t("settings.maxSession")}</label><input type="number" step="0.5" value={s.max_session_hours} onChange={set("max_session_hours")} /></div>
      <div className="field"><label htmlFor="work-start">{t("settings.workStart")}</label><input id="work-start" type="time" value={s.work_start ?? ""} onChange={set("work_start")} /></div>
      <div className="field"><label htmlFor="work-end">{t("settings.workEnd")}</label><input id="work-end" type="time" value={s.work_end ?? ""} onChange={set("work_end")} /></div>
      <fieldset className="field days">
        <legend>{t("settings.workDays")}</legend>
        {WEEK.map((bit) => {
          const days = s.work_days ?? 127;
          return (
            <label key={bit}>
              <input type="checkbox" checked={Boolean(days & (1 << bit))}
                onChange={(e) => setS({ ...s, work_days: e.target.checked ? days | (1 << bit) : days & ~(1 << bit) })} />
              {t(`settings.day.${bit}`)}
            </label>
          );
        })}
      </fieldset>
      <div className="field"><label htmlFor="grace">{t("settings.grace")}</label><input id="grace" type="number" step="1" min="0" max="240" value={s.late_grace_minutes ?? 15} onChange={set("late_grace_minutes")} /></div>
      <div className="field">
        <label htmlFor="break-mode">{t("settings.breakMode")}</label>
        <select id="break-mode" value={s.break_mode ?? "off"} onChange={set("break_mode")}>
          <option value="off">{t("settings.breakOff")}</option>
          <option value="fixed">{t("settings.breakFixed")}</option>
          <option value="flexible">{t("settings.breakFlexible")}</option>
        </select>
      </div>
      {s.break_mode === "fixed" && (
        <>
          <div className="row2">
            <div className="field"><label htmlFor="break-start">{t("settings.breakStart")}</label><input id="break-start" type="time" value={s.break_start ?? ""} onChange={set("break_start")} /></div>
            <div className="field"><label htmlFor="break-end">{t("settings.breakEnd")}</label><input id="break-end" type="time" value={s.break_end ?? ""} onChange={set("break_end")} /></div>
          </div>
          <div className="field check">
            <label><input type="checkbox" checked={Boolean(s.break_paid)} onChange={(e) => setS({ ...s, break_paid: e.target.checked })} />{t("settings.breakPaid")}</label>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="note-policy">{t("settings.notePolicy")}</label>
        <select id="note-policy" value={s.note_on_stop ?? "off"} onChange={set("note_on_stop")}>
          <option value="off">{t("settings.noteOff")}</option>
          <option value="optional">{t("settings.noteOptional")}</option>
          <option value="required">{t("settings.noteRequired")}</option>
        </select>
      </div>
      <div className="field check">
        <label><input id="activity-monitoring" type="checkbox" checked={Boolean(s.activity_monitoring)} onChange={(e) => setS({ ...s, activity_monitoring: e.target.checked })} />{t("settings.monitoring")}</label>
      </div>
      {s.activity_monitoring && (
        <div className="field">
          <label htmlFor="idle-minutes">{t("settings.idleMinutes")}</label>
          <input id="idle-minutes" type="number" step="1" min="1" max="240" value={s.idle_minutes ?? 30} onChange={set("idle_minutes")} />
        </div>
      )}
      <div className="field">
        <p className="hint" role="status" aria-label={t("settings.connAria")}>{connectionText}</p>
        <p className="hint">{t("settings.awareHint")}</p>
        {s.activity_monitoring && (!s.work_start || !s.work_end) && (
          <p className="hint">{t("settings.needHours")}</p>
        )}
        {conn?.unknown_active_users > 0 && (
          <p className="hint">{t("settings.unknownUsers", { n: conn.unknown_active_users })}</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="company-locale">{t("settings.companyLang")}</label>
        <select id="company-locale" value={s.locale ?? "ar"} onChange={set("locale")}>
          <option value="ar">{t("settings.langAr")}</option>
          <option value="en">{t("settings.langEn")}</option>
        </select>
      </div>
      {error && <div className="field"><span className="err">{t(error)}</span></div>}
      <div className="dlg-a"><Button onClick={save}>{t("common.save")}</Button></div>
    </section>
  );
}
