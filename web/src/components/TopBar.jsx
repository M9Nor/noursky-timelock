import { useI18n } from "../i18n.jsx";

const IS_DEV = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === "1";
const todayLabel = (locale) =>
  new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

export default function TopBar({ role, onRole }) {
  const { locale, t, setLocale } = useI18n();
  return (
    <header className="topbar">
      <div className="topbar-in">
        <div className="brand"><b>NourSky</b><span>TimeClock</span></div>
        <span className="date-label">{todayLabel(locale)}</span>
        {IS_DEV && (
          <fieldset className="seg" style={{ border: 0, margin: 0, minWidth: 0 }}>
            <legend className="sr">{t("topbar.view")}</legend>
            <input type="radio" name="role" id="roleEmp" checked={role === "employee"} onChange={() => onRole("employee")} />
            <label htmlFor="roleEmp">{t("topbar.employee")}</label>
            <input type="radio" name="role" id="roleMgr" checked={role === "manager"} onChange={() => onRole("manager")} />
            <label htmlFor="roleMgr">{t("topbar.manager")}</label>
          </fieldset>
        )}
        <button type="button" className="btn btn-ghost btn-sm lang" onClick={() => setLocale(locale === "ar" ? "en" : "ar")}>{t("lang.switch")}</button>
      </div>
    </header>
  );
}
