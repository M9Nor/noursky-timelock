import { useEffect, useRef, useState } from "react";
import { createApi, ApiError } from "./api.js";
import { ssoLogin, devLogin } from "./auth.js";
import EmployeeScreen from "./components/EmployeeScreen.jsx";
import ManagerDashboard from "./components/ManagerDashboard.jsx";

const IS_DEV = import.meta.env.DEV;

export default function App() {
  const tokenRef = useRef(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const retriedRef = useRef(false);

  // createApi reads the latest token, and re-auths once on 401.
  const api = useRef(null);
  if (!api.current) {
    const base = createApi(() => tokenRef.current);
    const wrap = (fn) => async (...args) => {
      try { return await fn(...args); }
      catch (e) {
        if (e instanceof ApiError && e.status === 401 && !retriedRef.current && !IS_DEV) {
          retriedRef.current = true;
          await doSsoLogin();
          return await fn(...args);
        }
        throw e;
      }
    };
    api.current = { get: wrap(base.get), post: wrap(base.post), put: wrap(base.put), patch: wrap(base.patch), rawUrl: base.rawUrl, download: wrap(base.download) };
  }

  async function doSsoLogin() {
    const { token, user } = await ssoLogin(createApi(() => null));
    tokenRef.current = token;
    setUser(user);
  }

  useEffect(() => {
    if (IS_DEV) { setReady(true); return; } // wait for role picker
    doSsoLogin().catch((e) => setError(e.code || e.message || "AUTH_FAILED")).finally(() => setReady(true));
  }, []);

  async function doDevLogin(role) {
    try {
      const { token, user } = await devLogin(createApi(() => null), role);
      tokenRef.current = token;
      setUser(user);
    } catch (e) { setError(e.code || "AUTH_FAILED"); }
  }

  if (error) return <div className="card error" style={{ maxWidth: 420, margin: "40px auto" }}>انتهت الجلسة، أعد فتح الصفحة</div>;
  if (!ready) return <div className="card muted" style={{ maxWidth: 420, margin: "40px auto" }}>جارٍ التحقق…</div>;

  if (!user) {
    if (IS_DEV) {
      return (
        <div className="card" style={{ maxWidth: 420, margin: "40px auto", textAlign: "center" }}>
          <p className="muted">وضع التطوير</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn" onClick={() => doDevLogin("employee")}>دخول كموظف</button>
            <button className="btn" onClick={() => doDevLogin("manager")}>دخول كمدير</button>
          </div>
        </div>
      );
    }
    return <div className="card muted" style={{ maxWidth: 420, margin: "40px auto" }}>جارٍ التحقق…</div>;
  }

  return user.role === "manager"
    ? <ManagerDashboard api={api.current} />
    : <EmployeeScreen api={api.current} />;
}
