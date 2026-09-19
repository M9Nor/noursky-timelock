const IS_DEV = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === "1";
const todayLabel = () =>
  new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

export default function TopBar({ role, onRole }) {
  return (
    <header className="topbar">
      <div className="topbar-in">
        <div className="brand"><b>NourSky</b><span>TimeClock</span></div>
        <span className="date-label">{todayLabel()}</span>
        {IS_DEV && (
          <fieldset className="seg" style={{ border: 0, margin: 0, minWidth: 0 }}>
            <legend className="sr">طريقة العرض</legend>
            <input type="radio" name="role" id="roleEmp" checked={role === "employee"} onChange={() => onRole("employee")} />
            <label htmlFor="roleEmp">الموظف</label>
            <input type="radio" name="role" id="roleMgr" checked={role === "manager"} onChange={() => onRole("manager")} />
            <label htmlFor="roleMgr">المدير</label>
          </fieldset>
        )}
      </div>
    </header>
  );
}
