# Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the existing React frontend with the NourSky professional design (light theme) from `docs/design-reference.html`, keeping all existing app logic and using only what the current backend already returns.

**Architecture:** Rewrite the presentation layer of the Vite SPA in `web/`. `App.jsx` keeps auth + role routing + the 401-wrapped api client; its child components are rebuilt on a new class-based `styles.css` ported from the mockup. No backend changes. No dark mode. Elements needing data the backend does not provide are omitted (see spec §9).

**Tech Stack:** React 18, Vite 5, plain CSS (class-based, ported tokens), Vitest + React Testing Library. No TypeScript, no CSS framework, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-09-19-frontend-redesign-design.md` (read it; the design source is `docs/design-reference.html`).

## Global Constraints

- Node ≥ 20, ESM, plain JavaScript (no TypeScript). React 18 + Vite. No new runtime dependencies.
- Arabic RTL (`dir="rtl" lang="ar"`). Numbers ALWAYS Western digits (1,2,3) — never Arabic-Indic. Use `tabular-nums`, `toFixed`, `String`/`padStart`, and `Intl` locale `en`/`en-GB` or the `-nu-latn` variant. Never an Arabic-Indic numbering locale.
- **Light theme only.** Port the mockup's `:root` light tokens verbatim. Do NOT add `@media (prefers-color-scheme: dark)`, `[data-theme]`, a theme toggle, the pre-paint theme script, or any `localStorage` use. `color-scheme: light`.
- Brand tokens (verbatim): `--accent:#6C5CE7`, `--accent-ink:#FFFFFF`, `--accent-soft:#F4F0FF`, `--pink:#E91E63`, `--head:#1A1A2E`, `--head-ink:#FFFFFF`, `--bg:#F7F7FB`, `--panel:#FFFFFF`, `--sunken:#F4F0FF`, `--ink:#20203A`, `--muted:#5A5A72`, `--line:#D9D6EA`, `--pos:#1E7F4F`, `--pos-soft:#E6F4EC`, `--neg:#C0392B`, `--neg-soft:#FBEAE8`, `--warn:#8A6508`, `--warn-soft:#FBF3DC`, `--shadow:0 1px 2px rgba(26,26,46,.06), 0 8px 24px rgba(26,26,46,.06)`, `--r-lg:20px`, `--r-md:14px`, `--r-sm:10px`, `--font:"IBM Plex Sans Arabic", Tahoma, "Segoe UI", sans-serif`.
- Token in memory only (React state/ref), never localStorage.
- Live timers derive from `server_time` via `serverOffset`/`nowWithOffset`, never the raw client clock.
- Keep dev-login gating (`import.meta.env.DEV`), the 401-retry-once in `App.jsx`, and the production build path intact.
- Errors are `{ error: "CODE" }`; map codes to the existing Arabic messages. No new error codes, no backend edits (`src/server.js`, `schema.sql`, `scripts/*` untouched).
- `archive/cloudflare-worker/` is reference only. Never edit it.
- Full Vitest suite must stay green. Commit with `git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit`, message body ending: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Do NOT commit `public/` or `node_modules` (gitignored). Run `git status` before each commit.

---

## File Structure

**Rewritten (all `web/src/`):**
- `styles.css` — full rewrite: light tokens + base + all component classes ported from `docs/design-reference.html` (topbar, panel, btn, chip, kpis, floor, table, dialog, toast, responsive). No dark blocks.
- `components/Icon.jsx` — inline SVG set as `<Icon name="..." />`.
- `components/Toast.jsx` + `components/ToastContext.jsx` — transient status messages via a `useToast()` hook.
- `components/Button.jsx` — mockup `.btn` variants (primary/ghost/danger, lg/sm) + loading/disabled.
- `components/TopBar.jsx` — brand, today label, dev-only role segmented control (no theme toggle).
- `components/EmployeeScreen.jsx` — hero (greeting, status chip, big timer, meta, progress, Start/Stop), week total (numeric), day log.
- `components/KpiRow.jsx` — KPIs from `/admin/live` + `/admin/report`.
- `components/LiveFloor.jsx` — working / offline lanes (replaces `LivePanel.jsx`).
- `components/ReportPanel.jsx` — period filter incl. custom range, search, table, CSV, row→sessions→edit.
- `components/SessionEditModal.jsx` — `<dialog>`-styled edit form.
- `components/SettingsPanel.jsx` — `.field`-styled settings form.
- `components/ManagerDashboard.jsx` — shell composing KpiRow + LiveFloor + ReportPanel + SettingsPanel.
- `App.jsx` — modified: wrap tree in ToastProvider, TopBar, dev-only role override; keep auth/401/routing.
- `time.js` — add `formatClock(sec)` → `{h, mm, ss}` for the hero; keep existing helpers.
- `index.html` — add IBM Plex Sans Arabic Google Fonts links.

**Deleted:** `components/LivePanel.jsx` + `LivePanel.test.jsx` (replaced by LiveFloor).

**Unchanged:** `api.js`, `auth.js`, backend, `main.jsx`.

---

## Task 1: Design system — styles.css, index.html fonts, Icon, time.formatClock

Establishes the visual foundation everything else uses. Ports the mockup's light-theme CSS, adds the font, provides the icon set and the hero clock formatter. Deliverable: the app builds, renders with the new base styles and font, and `formatClock` is unit-tested.

**Files:**
- Rewrite: `web/src/styles.css`
- Modify: `web/index.html`
- Create: `web/src/components/Icon.jsx`
- Modify: `web/src/time.js`
- Test: `web/src/time.test.js` (extend)

**Interfaces:**
- Consumes: `docs/design-reference.html` (the CSS source), existing `time.js` exports.
- Produces:
  - `styles.css` with light tokens on `:root` and all component classes from the mockup.
  - `Icon({ name, size })` → inline `<svg class="i">`; `name` ∈ `play|stop|search|download|plus|check|x`. `size` optional (px), default from CSS.
  - `formatClock(sec)` → `{ h: number, mm: string, ss: string }` (mm/ss zero-padded, Western digits), clamps negatives to 0.

- [ ] **Step 1: Extend time.test.js with a failing test for formatClock**

Append to `web/src/time.test.js`:

```js
import { formatClock } from "./time.js";

describe("formatClock", () => {
  it("splits seconds into h / padded mm / padded ss", () => {
    expect(formatClock(0)).toEqual({ h: 0, mm: "00", ss: "00" });
    expect(formatClock(65)).toEqual({ h: 0, mm: "01", ss: "05" });
    expect(formatClock(3661)).toEqual({ h: 1, mm: "01", ss: "01" });
    expect(formatClock(36000)).toEqual({ h: 10, mm: "00", ss: "00" });
  });
  it("clamps negatives to zero", () => {
    expect(formatClock(-5)).toEqual({ h: 0, mm: "00", ss: "00" });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/time.test.js`
Expected: FAIL — `formatClock` is not exported.

- [ ] **Step 3: Implement formatClock in time.js**

Append to `web/src/time.js`:

```js
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return { h: Math.floor(s / 3600), mm: pad(Math.floor((s % 3600) / 60)), ss: pad(s % 60) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/time.test.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Add fonts to index.html**

In `web/index.html`, inside `<head>` (after the viewport meta), add exactly:

```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

Keep `<html dir="rtl" lang="ar">` and `<title>الدوام</title>`.

- [ ] **Step 6: Rewrite styles.css from the mockup (light theme only)**

Open `docs/design-reference.html`. Copy its `<style>` block into `web/src/styles.css` with these REQUIRED edits:
- Keep the `:root{...}` light token block verbatim (the Global Constraints list).
- DELETE the `@media (prefers-color-scheme: dark)` block, the `:root[data-theme="dark"]` block, and `color-scheme:dark`. Keep `color-scheme:light` on `:root`.
- Keep every component class: `.topbar`, `.brand`, `.seg`, `.icon-btn`, `main`, `.grid`, `.panel`, `.panel-h`, `h2`, `h3`, `.hint`, `.btn` + variants, `.chip` + variants, `.hero`, `.timer`, `.hero-meta`, `.goal`, `.actions`, `.list`, `.empty`, `.kpis`, `.kpi`, `.floor`, `.lane`, `.person`, `.avatar`, `.toolbar`, `.filters`, `.search`, `.table-wrap`, `table`/`th`/`td`, `.who`, `dialog`/`.dlg`/`.field`/`.row2`/`.dlg-a`/`.summary`/`.note`, `.toast`, `svg.i`, `.sr`/`.skip`/`.ltr`/`.muted`, and all `@media` responsive blocks (1080/900/600) and `prefers-reduced-motion`.
- You may keep classes for cut features (`.track`, `.bars`, `.heat`, `.req`, `.appr-grid`) — unused CSS is harmless. Do not spend effort removing them.
- Ensure `body` sets `background:var(--bg)`, `color:var(--ink)`, the font, and `font-variant-numeric:tabular-nums`.

- [ ] **Step 7: Create Icon.jsx**

```jsx
const PATHS = {
  play: <path d="M7 5v14l11-7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  download: <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 5 5 9-10" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
};
export default function Icon({ name, size }) {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg className="i" viewBox="0 0 24 24" style={style} aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}
```

- [ ] **Step 8: Build to verify the design system compiles**

Run: `cd web && npx vitest run && npm run build`
Expected: tests PASS; build succeeds; `../public/index.html` written. Open `public/index.html` and confirm the font `<link>`s are present (Vite copies index.html).

- [ ] **Step 9: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/styles.css web/index.html web/src/components/Icon.jsx web/src/time.js web/src/time.test.js
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): port NourSky design system (light), fonts, Icon, formatClock

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Toast + Button

Shared UI primitives the screens depend on: a toast system (context + hook + host component) and the restyled Button. Delivered together — small, and every later task uses both.

**Files:**
- Create: `web/src/components/ToastContext.jsx`, `web/src/components/Toast.jsx`
- Rewrite: `web/src/components/Button.jsx`
- Test: `web/src/components/Toast.test.jsx`, `web/src/components/Button.test.jsx`

**Interfaces:**
- Consumes: `Icon` (Task 1), `styles.css` `.toast`/`.btn` classes.
- Produces:
  - `ToastProvider({ children })` — wraps the app; renders the toast host.
  - `useToast()` → `(message: string) => void` — shows a toast for ~2.6s.
  - `Button({ onClick, loading, disabled, variant, size, children })` — `variant` ∈ `primary|ghost|danger` (default primary), `size` ∈ `lg|sm|undefined`; className `btn btn-<variant> [btn-<size>]`; disabled when `loading || disabled`; shows `…` when loading else children.

- [ ] **Step 1: Write failing Button test**

`web/src/components/Button.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Button from "./Button.jsx";

describe("Button", () => {
  it("applies variant and size classes", () => {
    render(<Button variant="danger" size="lg">إنهاء</Button>);
    const b = screen.getByRole("button", { name: "إنهاء" });
    expect(b.className).toContain("btn-danger");
    expect(b.className).toContain("btn-lg");
  });
  it("disables and shows ellipsis while loading", () => {
    render(<Button loading>ابدأ</Button>);
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    expect(b.textContent).toBe("…");
  });
  it("calls onClick", () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>ابدأ</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(fn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/Button.test.jsx`
Expected: FAIL — current Button has no variant/size API.

- [ ] **Step 3: Rewrite Button.jsx**

```jsx
export default function Button({ onClick, loading, disabled, variant = "primary", size, children, type = "button" }) {
  const cls = ["btn", `btn-${variant}`, size ? `btn-${size}` : ""].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={loading || disabled}>
      {loading ? "…" : children}
    </button>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/Button.test.jsx`
Expected: PASS (3).

- [ ] **Step 5: Write failing Toast test**

`web/src/components/Toast.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./ToastContext.jsx";

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast("تم الحفظ")}>go</button>;
}

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("shows a message then hides it", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    act(() => { screen.getByText("go").click(); });
    expect(screen.getByText("تم الحفظ")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText("تم الحفظ")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `cd web && npx vitest run src/components/Toast.test.jsx`
Expected: FAIL — cannot resolve `./ToastContext.jsx`.

- [ ] **Step 7: Implement ToastContext.jsx and Toast.jsx**

`web/src/components/ToastContext.jsx`:

```jsx
import { createContext, useCallback, useContext, useRef, useState } from "react";
import Icon from "./Icon.jsx";

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const toast = useCallback((message) => {
    setMsg(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className={`toast${msg ? " show" : ""}`} role="status" aria-live="polite">
        {msg && <><Icon name="check" size={18} />{msg}</>}
      </div>
    </ToastCtx.Provider>
  );
}
```

`web/src/components/Toast.jsx` (re-export so imports are stable):

```jsx
export { ToastProvider, useToast } from "./ToastContext.jsx";
```

- [ ] **Step 8: Run to verify pass**

Run: `cd web && npx vitest run src/components/Toast.test.jsx`
Expected: PASS (1).

- [ ] **Step 9: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/components/Button.jsx web/src/components/Button.test.jsx web/src/components/Toast.jsx web/src/components/ToastContext.jsx web/src/components/Toast.test.jsx
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): toast system and restyled Button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: TopBar + App integration

The sticky top bar (brand, date, dev-only role control) and wiring App to provide the toast context and render TopBar above the routed screen. Keeps App's auth/401/routing logic; adds a dev-only manual role override so the segmented control works in dev, exactly like dev-login.

**Files:**
- Create: `web/src/components/TopBar.jsx`
- Modify: `web/src/App.jsx`
- Test: `web/src/components/TopBar.test.jsx`; update `web/src/App.test.jsx`

**Interfaces:**
- Consumes: `useToast` wrap (Task 2), existing `App.jsx` auth (`user`, `api`).
- Produces:
  - `TopBar({ role, onRole })` — brand “NourSky / TimeClock”, today label; when `import.meta.env.DEV`, a segmented radio control (موظف / المدير) bound to `role`, calling `onRole("employee"|"manager")`. In production the control is not rendered.
  - App renders `<ToastProvider><TopBar .../><main>{screen}</main></ToastProvider>`; in dev the visible screen follows the TopBar override, in prod it follows `user.role`.

- [ ] **Step 1: Write failing TopBar test**

`web/src/components/TopBar.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TopBar from "./TopBar.jsx";

describe("TopBar", () => {
  it("renders brand and a today label", () => {
    render(<TopBar role="employee" onRole={() => {}} />);
    expect(screen.getByText("NourSky")).toBeInTheDocument();
  });
  it("in dev, switching role calls onRole", () => {
    const onRole = vi.fn();
    render(<TopBar role="employee" onRole={onRole} />);
    // dev build: segmented control present
    fireEvent.click(screen.getByLabelText("المدير"));
    expect(onRole).toHaveBeenCalledWith("manager");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/TopBar.test.jsx`
Expected: FAIL — cannot resolve `./TopBar.jsx`.

- [ ] **Step 3: Implement TopBar.jsx**

```jsx
const IS_DEV = import.meta.env.DEV;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/TopBar.test.jsx`
Expected: PASS (2). (Under Vitest, `import.meta.env.DEV` is true, so the control renders.)

- [ ] **Step 5: Modify App.jsx to add ToastProvider + TopBar + role override**

Read the current `web/src/App.jsx`. Make these changes, keeping ALL existing auth/401/routing logic:
- Import `ToastProvider` from `./components/Toast.jsx` and `TopBar` from `./components/TopBar.jsx`.
- Add role-override state: `const [roleOverride, setRoleOverride] = useState(null);` and compute `const role = roleOverride ?? user?.role;`.
- Wrap the authenticated return in `<ToastProvider>`, render `<TopBar role={role} onRole={setRoleOverride} />` above a `<main className="main-wrap">` (or reuse existing container), and route on `role` instead of `user.role`.
- Keep the dev role-picker (login buttons) and error/loading screens as-is. The TopBar override only applies after login.
- Do not change `api`, `doSsoLogin`, `doDevLogin`, the 401 wrapper, or dev gating.

Exact routing line becomes:

```jsx
{role === "manager" ? <ManagerDashboard api={api.current} /> : <EmployeeScreen api={api.current} user={user} />}
```

- [ ] **Step 6: Update App.test.jsx**

The existing App tests click "دخول كمدير"/"دخول كموظف" then assert a child screen renders. Keep them. Add nothing that depends on TopBar internals. Re-run:

Run: `cd web && npx vitest run src/App.test.jsx`
Expected: PASS. If a test now fails only because the dashboard/employee markup changed, update the asserted text to a stable label that still exists (e.g. the manager tab label "التقرير" or the employee button "بدء الدوام"). Do not weaken assertions to always-true.

- [ ] **Step 7: Full suite + build**

Run: `cd web && npx vitest run && npm run build`
Expected: all PASS; build OK.

- [ ] **Step 8: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/components/TopBar.jsx web/src/components/TopBar.test.jsx web/src/App.jsx web/src/App.test.jsx
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): sticky TopBar with dev role control, App toast+routing wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: EmployeeScreen (hero clock, totals, day log)

Rebuild the employee screen on the hero design: greeting, status chip, big H:MM:SS timer, meta (today target / remaining / expected out), progress bar, Start/Stop, week total, and a minimal day log — all from `/me/status`.

**Files:**
- Rewrite: `web/src/components/EmployeeScreen.jsx`
- Test: `web/src/components/EmployeeScreen.test.jsx` (rewrite)

**Interfaces:**
- Consumes: `Button`, `Icon`, `useToast`, `formatClock`, `formatHours`, `serverOffset`, `nowWithOffset`, `api` prop, optional `user` prop (for the greeting name).
- Backend: `GET /me/status` → `{ open_session:{id,started_at}|null, worked_sec, server_time }`; `POST /session/start`; `POST /session/stop`.
- Produces: `EmployeeScreen({ api, user })` default export.

- [ ] **Step 1: Rewrite the test**

Replace `web/src/components/EmployeeScreen.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import EmployeeScreen from "./EmployeeScreen.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

function makeApi(status) {
  return { get: vi.fn(async () => status), post: vi.fn(async () => ({})) };
}

describe("EmployeeScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows start button when no open session", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: 1000 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /بدء الدوام/ })).toBeInTheDocument();
  });

  it("shows end button when a session is open", async () => {
    const started = Math.floor(Date.now() / 1000) - 60;
    const api = makeApi({ open_session: { id: "s1", started_at: started }, worked_sec: 60, server_time: started + 60 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByRole("button", { name: /إنهاء الدوام/ })).toBeInTheDocument();
  });

  it("calls /session/start on click", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: 1000 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /بدء الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/start"));
  });

  it("greets the user by name", async () => {
    const api = makeApi({ open_session: null, worked_sec: 0, server_time: 1000 });
    wrap(<EmployeeScreen api={api} user={{ name: "سارة" }} />);
    expect(await screen.findByText(/سارة/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/EmployeeScreen.test.jsx`
Expected: FAIL (labels changed from old "ابدأ الدوام" to "بدء الدوام", greeting added).

- [ ] **Step 3: Rewrite EmployeeScreen.jsx**

```jsx
import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatClock, formatHours, serverOffset, nowWithOffset } from "../time.js";

const DAILY_TARGET_SEC = 8 * 3600; // employee has no settings route; spec §7 default

export default function EmployeeScreen({ api, user }) {
  const [status, setStatus] = useState(null);
  const [weekSec, setWeekSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);
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

  useEffect(() => { refresh().catch((e) => setError(e.code || "INTERNAL_ERROR")); }, []);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function toggle() {
    setLoading(true); setError("");
    const opening = !status?.open_session;
    try {
      await api.post(opening ? "/session/start" : "/session/stop");
      await refresh();
      toast(opening ? "بدأ دوامك" : "انتهى دوامك");
    } catch (e) {
      setError(e.code || "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  }

  if (!status && !error) return <div className="panel muted">جارٍ التحميل…</div>;

  const open = status?.open_session;
  const liveSec = open ? nowWithOffset(offsetRef.current) - open.started_at : 0;
  const todaySec = (status?.worked_sec ?? 0) + (open ? liveSec : 0);
  const clock = formatClock(open ? liveSec : 0);
  const remain = Math.max(0, DAILY_TARGET_SEC - todaySec);
  const pct = Math.min(100, (todaySec / DAILY_TARGET_SEC) * 100);
  const name = user?.name || "";

  return (
    <div className="grid emp">
      <div className="hero">
        <div>
          <div className="hero-top">
            <span className="hello">مرحباً{name ? `، ${name}` : ""}</span>
            <span className={`chip ${open ? "work" : "off"}`}>{open ? "داخل الدوام" : "لم يسجّل الدخول"}</span>
          </div>
          <div className="timer" aria-live="off">{clock.h}:{clock.mm}<span className="sec">:{clock.ss}</span></div>
          <div className="hero-meta">
            <div>ساعات اليوم المطلوبة<strong className="ltr">{formatHours(DAILY_TARGET_SEC)}</strong></div>
            <div>المتبقي<strong className="ltr">{remain > 0 ? formatHours(remain) : "اكتملت"}</strong></div>
            <div>مجموع اليوم<strong className="ltr">{formatHours(todaySec)}</strong></div>
          </div>
          <div className="goal" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <i style={{ width: pct + "%" }} />
          </div>
        </div>
        <div className="actions">
          <Button onClick={toggle} loading={loading} variant={open ? "danger" : "primary"} size="lg">
            <Icon name={open ? "stop" : "play"} />{open ? "إنهاء الدوام" : "بدء الدوام"}
          </Button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-h"><h2>ساعاتي هذا الأسبوع</h2></div>
        <p className="hero-meta"><span>المجموع<strong className="ltr">{formatHours(weekSec)}</strong></span></p>
      </section>

      {error && <div className="panel error">حدث خطأ، حاول مرة أخرى</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/EmployeeScreen.test.jsx`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): redesigned employee hero screen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: KpiRow + LiveFloor (replaces LivePanel)

The manager's top-of-dashboard: a KPI row and a live floor of who is working vs offline, both from `/admin/live` (+ report for KPIs). Deletes the old LivePanel.

**Files:**
- Create: `web/src/components/KpiRow.jsx`, `web/src/components/LiveFloor.jsx`
- Delete: `web/src/components/LivePanel.jsx`, `web/src/components/LivePanel.test.jsx`
- Test: `web/src/components/KpiRow.test.jsx`, `web/src/components/LiveFloor.test.jsx`

**Interfaces:**
- Consumes: `formatDuration`, `serverOffset`, `nowWithOffset`, `api`.
- Backend: `GET /admin/live` → `{ server_time, employees:[{user_id,name,email,session_id,started_at}] }`.
- Produces:
  - `KpiRow({ live })` — pure presentational; `live` = the `/admin/live` payload. Renders KPIs: داخل الدوام الآن (count with session_id) / إجمالي الموظفين (length). Two KPIs, real data only.
  - `LiveFloor({ api })` — fetches `/admin/live`, 30s poll + 1s tick (both cleaned up), lanes “داخل الدوام” and “غير متصل”, live duration per working person via server-time offset. Renders `<KpiRow live={data} />` at top.

- [ ] **Step 1: Write failing KpiRow test**

`web/src/components/KpiRow.test.jsx`:

```jsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import KpiRow from "./KpiRow.jsx";

describe("KpiRow", () => {
  it("counts working vs total from live payload", () => {
    render(<KpiRow live={{ server_time: 1, employees: [
      { user_id: "a", name: "أحمد", session_id: "s1", started_at: 0 },
      { user_id: "b", name: "سارة", session_id: null, started_at: null },
    ] }} />);
    expect(screen.getByText("داخل الدوام الآن").closest(".kpi").textContent).toContain("1");
    expect(screen.getByText("إجمالي الموظفين").closest(".kpi").textContent).toContain("2");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/KpiRow.test.jsx`
Expected: FAIL — cannot resolve `./KpiRow.jsx`.

- [ ] **Step 3: Implement KpiRow.jsx**

```jsx
export default function KpiRow({ live }) {
  const employees = live?.employees ?? [];
  const working = employees.filter((e) => e.session_id != null).length;
  return (
    <dl className="kpis" style={{ margin: 0 }}>
      <div className="kpi acc"><dt>داخل الدوام الآن</dt><dd>{working} <small>/ {employees.length}</small></dd></div>
      <div className="kpi"><dt>إجمالي الموظفين</dt><dd>{employees.length}</dd></div>
    </dl>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/KpiRow.test.jsx`
Expected: PASS (1).

- [ ] **Step 5: Write failing LiveFloor test**

`web/src/components/LiveFloor.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LiveFloor from "./LiveFloor.jsx";

describe("LiveFloor", () => {
  it("splits working and offline employees", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      employees: [
        { user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 120 },
        { user_id: "b", name: "سارة", session_id: null, started_at: null },
      ],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("سارة")).toBeInTheDocument();
    // one working lane entry
    expect(screen.getByText("داخل الدوام").closest(".lane").textContent).toContain("أحمد");
    expect(screen.getByText("غير متصل").closest(".lane").textContent).toContain("سارة");
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `cd web && npx vitest run src/components/LiveFloor.test.jsx`
Expected: FAIL — cannot resolve `./LiveFloor.jsx`.

- [ ] **Step 7: Implement LiveFloor.jsx**

```jsx
import { useEffect, useRef, useState } from "react";
import KpiRow from "./KpiRow.jsx";
import { formatDuration, serverOffset, nowWithOffset } from "../time.js";

const initials = (n) => (n || "؟").trim().charAt(0);

export default function LiveFloor({ api }) {
  const [data, setData] = useState(null);
  const [, setTick] = useState(0);
  const offsetRef = useRef(0);

  async function refresh() {
    const d = await api.get("/admin/live");
    offsetRef.current = serverOffset(d.server_time);
    setData(d);
  }
  useEffect(() => {
    refresh().catch(() => {});
    const poll = setInterval(() => refresh().catch(() => {}), 30000);
    const tick = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  if (!data) return <div className="panel muted">جارٍ التحميل…</div>;
  const working = data.employees.filter((e) => e.session_id != null);
  const offline = data.employees.filter((e) => e.session_id == null);
  const lane = (label, people, live) => (
    <div className="lane" aria-label={`${label}: ${people.length}`}>
      <div className="lane-h"><span>{label}</span><b>{people.length}</b></div>
      {people.length ? people.map((p) => (
        <div className="person" key={p.user_id}>
          <span className="avatar" aria-hidden="true">{initials(p.name)}</span>
          <div style={{ minWidth: 0 }}>
            <div className="n">{p.name}</div>
            {live && <div className="m">{formatDuration(nowWithOffset(offsetRef.current) - p.started_at)}</div>}
          </div>
        </div>
      )) : <div className="hint" style={{ textAlign: "center", padding: "12px 0" }}>لا أحد</div>}
    </div>
  );

  return (
    <>
      <KpiRow live={data} />
      <section className="panel">
        <div className="panel-h"><h2>الفريق الآن</h2></div>
        <div className="floor">
          {lane("داخل الدوام", working, true)}
          {lane("غير متصل", offline, false)}
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 8: Run to verify pass**

Run: `cd web && npx vitest run src/components/LiveFloor.test.jsx`
Expected: PASS (1).

- [ ] **Step 9: Delete the old LivePanel**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git rm web/src/components/LivePanel.jsx web/src/components/LivePanel.test.jsx
```

- [ ] **Step 10: Full suite**

Run: `cd web && npx vitest run`
Expected: all PASS (LivePanel tests gone; KpiRow + LiveFloor pass). If ManagerDashboard still imports LivePanel it will be fixed in Task 7 — if the suite fails only on ManagerDashboard's import, that's expected now; note it and proceed. (To keep the suite green between tasks, you may leave ManagerDashboard importing LivePanel until Task 7 by NOT deleting yet — but the plan deletes here; if the build breaks, Task 7 immediately follows.)

Ruling for the implementer: if deleting LivePanel now breaks ManagerDashboard's import and thus the suite/build, instead of deleting the files in this task, leave them in place and let Task 7 delete them after swapping the import. Prefer a green suite at each task boundary.

- [ ] **Step 11: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/components/KpiRow.jsx web/src/components/KpiRow.test.jsx web/src/components/LiveFloor.jsx web/src/components/LiveFloor.test.jsx
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): KpiRow and LiveFloor (live team floor)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: ReportPanel (period filter + custom range, search, table, CSV, edit) + SessionEditModal

Rebuild the report on the new table/toolbar design, adding a custom date range and a search box, keeping the authenticated CSV download and the session edit flow. SessionEditModal is restyled to the `<dialog>` look.

**Files:**
- Rewrite: `web/src/components/ReportPanel.jsx`, `web/src/components/SessionEditModal.jsx`
- Test: `web/src/components/ReportPanel.test.jsx` (rewrite), `web/src/components/SessionEditModal.test.jsx` (keep/adjust)

**Interfaces:**
- Consumes: `Button`, `Icon`, `useToast`, `formatHours`, `api`.
- Backend: `GET /admin/report?from=&to=`, `GET /admin/sessions?from=&to=&user_id=`, `PATCH /admin/sessions/:id`, `GET /admin/export.csv?from=&to=` (via `api.download`).
- Produces:
  - `ReportPanel({ api })` — exports `todayRange()/weekRange()/monthRange()` → `{from,to}` unix seconds; a custom range (two `date` inputs → from/to); search filter by name; table (employee, hours, target, completion%, days, auto-closed); CSV via `api.download`; row click → sessions detail → SessionEditModal.
  - `SessionEditModal({ api, session, onClose, onSaved })` — `<dialog>`-styled; start/end datetime-local; mandatory reason; INVALID_TIMES → "الأوقات غير صحيحة".

- [ ] **Step 1: Rewrite ReportPanel test**

Replace `web/src/components/ReportPanel.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import ReportPanel from "./ReportPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

function makeApi() {
  return {
    get: vi.fn(async (p) => p.startsWith("/admin/report")
      ? { from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8,
          employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 }] }
      : { sessions: [] }),
    download: vi.fn(async () => {}),
  };
}

describe("ReportPanel", () => {
  it("renders per-employee hours", async () => {
    wrap(<ReportPanel api={makeApi()} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("1.00")).toBeInTheDocument();
  });

  it("exports CSV through the authenticated client", async () => {
    const api = makeApi();
    wrap(<ReportPanel api={api} />);
    await screen.findByText("أحمد");
    fireEvent.click(screen.getByRole("button", { name: /تصدير CSV/ }));
    await waitFor(() => expect(api.download).toHaveBeenCalled());
    const [path, filename] = api.download.mock.calls[0];
    expect(path).toMatch(/^\/admin\/export\.csv\?from=\d+&to=\d+$/);
    expect(filename).toMatch(/\.csv$/);
  });

  it("filters by search text", async () => {
    const api = {
      get: vi.fn(async (p) => p.startsWith("/admin/report")
        ? { from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8, employees: [
            { user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 },
            { user_id: "b", name: "سارة", worked_sec: 7200, sessions_count: 1, days_present: 1, auto_closed: 0 },
          ] }
        : { sessions: [] }),
      download: vi.fn(),
    };
    wrap(<ReportPanel api={api} />);
    await screen.findByText("أحمد");
    fireEvent.change(screen.getByPlaceholderText(/بحث/), { target: { value: "سارة" } });
    expect(screen.queryByText("أحمد")).not.toBeInTheDocument();
    expect(screen.getByText("سارة")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/ReportPanel.test.jsx`
Expected: FAIL (new toolbar/search markup not present).

- [ ] **Step 3: Rewrite ReportPanel.jsx**

```jsx
import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import Icon from "./Icon.jsx";
import { useToast } from "./ToastContext.jsx";
import { formatHours } from "../time.js";
import SessionEditModal from "./SessionEditModal.jsx";

export function todayRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 86400, to }; }
export function weekRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 7 * 86400, to }; }
export function monthRange() { const to = Math.floor(Date.now() / 1000); return { from: to - 30 * 86400, to }; }

const toDateInput = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const fromDateInput = (v, endOfDay) => Math.floor(new Date(v + (endOfDay ? "T23:59:59" : "T00:00:00")).getTime() / 1000);

function completionColor(pct) {
  if (pct >= 90) return "var(--pos)";
  if (pct >= 60) return "var(--warn)";
  return "var(--neg)";
}

export default function ReportPanel({ api }) {
  const [range, setRange] = useState(weekRange());
  const [preset, setPreset] = useState("week");
  const [report, setReport] = useState(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const toast = useToast();

  async function load() {
    try { setReport(await api.get(`/admin/report?from=${range.from}&to=${range.to}`)); }
    catch { setError("حدث خطأ، حاول مرة أخرى"); }
  }
  useEffect(() => { load(); }, [range.from, range.to]);

  function pick(name, r) { setPreset(name); setRange(r); }
  function setCustom(which, value) {
    if (!value) return;
    setPreset("custom");
    setRange((cur) => ({ ...cur, [which]: which === "from" ? fromDateInput(value, false) : fromDateInput(value, true) }));
  }

  async function openDetail(emp) {
    const d = await api.get(`/admin/sessions?from=${range.from}&to=${range.to}&user_id=${emp.user_id}`);
    setDetail({ ...emp, sessions: d.sessions });
  }
  async function exportCsv() {
    try { await api.download(`/admin/export.csv?from=${range.from}&to=${range.to}`, `timeclock-${range.from}-${range.to}.csv`); toast("تم تصدير الملف"); }
    catch { setError("حدث خطأ، حاول مرة أخرى"); }
  }

  if (!report && !error) return <div className="panel muted">جارٍ التحميل…</div>;

  const employees = (report?.employees ?? []).filter((e) => !query.trim() || e.name?.includes(query.trim()));
  const target = report?.daily_target_hours ?? 8;

  return (
    <section className="panel">
      <div className="panel-h">
        <h2>التقرير</h2>
        <div className="toolbar">
          <div className="filters" role="group" aria-label="الفترة">
            <button type="button" aria-pressed={preset === "today"} onClick={() => pick("today", todayRange())}>اليوم</button>
            <button type="button" aria-pressed={preset === "week"} onClick={() => pick("week", weekRange())}>الأسبوع</button>
            <button type="button" aria-pressed={preset === "month"} onClick={() => pick("month", monthRange())}>الشهر</button>
          </div>
          <input type="date" aria-label="من" value={toDateInput(range.from)} onChange={(e) => setCustom("from", e.target.value)} />
          <input type="date" aria-label="إلى" value={toDateInput(range.to)} onChange={(e) => setCustom("to", e.target.value)} />
          <div className="search">
            <label htmlFor="empq" className="sr">بحث عن موظف</label>
            <input id="empq" type="search" placeholder="بحث عن موظف" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Icon name="search" />
          </div>
          <Button variant="ghost" size="sm" onClick={exportCsv}><Icon name="download" size={18} />تصدير CSV</Button>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th scope="col">الموظف</th><th scope="col">ساعات العمل</th><th scope="col">الهدف</th>
            <th scope="col">الإنجاز</th><th scope="col">أيام الحضور</th><th scope="col">مغلقة تلقائياً</th>
          </tr></thead>
          <tbody>
            {employees.length ? employees.map((e) => {
              const t = e.days_present * target;
              const workedH = Number(formatHours(e.worked_sec));
              const pct = t > 0 ? Math.round((workedH / t) * 100) : 0;
              return (
                <tr key={e.user_id} style={{ cursor: "pointer" }} onClick={() => openDetail(e)}>
                  <td><div className="who"><span className="avatar" aria-hidden="true">{(e.name || "؟").charAt(0)}</span><div className="n">{e.name}</div></div></td>
                  <td className="num">{formatHours(e.worked_sec)}</td>
                  <td className="num">{t.toFixed(2)}</td>
                  <td className="num" style={{ color: completionColor(pct) }}>{pct}%</td>
                  <td className="num">{e.days_present}</td>
                  <td className="num">{e.auto_closed}</td>
                </tr>
              );
            }) : <tr><td colSpan={6} className="empty">لا يوجد موظفون مطابقون.</td></tr>}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h"><h3>جلسات: {detail.name}</h3><Button variant="ghost" size="sm" onClick={() => setDetail(null)}>إغلاق</Button></div>
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">البداية</th><th scope="col">النهاية</th><th scope="col">الإغلاق</th><th scope="col"></th></tr></thead>
            <tbody>{detail.sessions.map((s) => (
              <tr key={s.id}>
                <td className="num">{new Date(s.started_at * 1000).toLocaleString("en-GB")}</td>
                <td className="num">{s.ended_at ? new Date(s.ended_at * 1000).toLocaleString("en-GB") : "مفتوحة"}</td>
                <td>{s.closed_by ?? "—"}</td>
                <td><Button variant="ghost" size="sm" onClick={() => setEditing(s)}>تعديل</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {editing && (
        <SessionEditModal api={api} session={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); toast("تم حفظ التعديل"); await load(); if (detail) await openDetail(detail); }} />
      )}

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}
```

- [ ] **Step 4: Run ReportPanel test (needs SessionEditModal to exist)**

Run: `cd web && npx vitest run src/components/ReportPanel.test.jsx`
Expected: it imports the existing `SessionEditModal.jsx` (still present) so it resolves; tests PASS (3). If the current SessionEditModal markup differs, the ReportPanel tests here don't touch the modal, so they should pass regardless.

- [ ] **Step 5: Rewrite SessionEditModal test**

Replace `web/src/components/SessionEditModal.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SessionEditModal from "./SessionEditModal.jsx";

describe("SessionEditModal", () => {
  const base = { id: "s1", started_at: 1000, ended_at: 4600 };
  it("blocks save without a reason", () => {
    const api = { patch: vi.fn() };
    render(<SessionEditModal api={api} session={base} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    expect(screen.getByText(/سبب التعديل مطلوب/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });
  it("PATCHes with reason and calls onSaved", async () => {
    const api = { patch: vi.fn().mockResolvedValue({}) };
    const onSaved = vi.fn();
    render(<SessionEditModal api={api} session={base} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText(/سبب/), { target: { value: "نسي يسجل" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [path, body] = api.patch.mock.calls[0];
    expect(path).toBe("/admin/sessions/s1");
    expect(body.reason).toBe("نسي يسجل");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
```

- [ ] **Step 6: Run to verify fail (if markup changed)**

Run: `cd web && npx vitest run src/components/SessionEditModal.test.jsx`
Expected: PASS if the current modal already matches; if it fails on the placeholder text, proceed to Step 7 to align markup.

- [ ] **Step 7: Rewrite SessionEditModal.jsx to the dialog look**

```jsx
import { useState } from "react";
import Button from "./Button.jsx";

const toLocalInput = (sec) => {
  const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);

export default function SessionEditModal({ api, session, onClose, onSaved }) {
  const [start, setStart] = useState(toLocalInput(session.started_at));
  const [end, setEnd] = useState(toLocalInput(session.ended_at ?? session.started_at + 3600));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!reason.trim()) { setError("سبب التعديل مطلوب"); return; }
    setSaving(true); setError("");
    try {
      await api.patch(`/admin/sessions/${session.id}`, { started_at: fromLocalInput(start), ended_at: fromLocalInput(end), reason: reason.trim() });
      onSaved();
    } catch (e) {
      setError(e.code === "INVALID_TIMES" ? "الأوقات غير صحيحة" : "حدث خطأ، حاول مرة أخرى");
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,20,37,.5)", display: "grid", placeItems: "center", zIndex: 60 }}>
      <div className="dlg" style={{ background: "var(--panel)", borderRadius: "var(--r-lg)", width: "min(480px, calc(100vw - 32px))" }}>
        <h2>تعديل الجلسة</h2>
        <div className="row2">
          <div className="field"><label>البداية</label><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="field"><label>النهاية</label><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        <div className="field"><label>سبب التعديل</label><textarea placeholder="سبب التعديل" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {error && <div className="field"><span className="err">{error}</span></div>}
        <div className="dlg-a">
          <Button onClick={save} loading={saving}>حفظ</Button>
          <Button variant="ghost" onClick={onClose}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run both tests**

Run: `cd web && npx vitest run src/components/ReportPanel.test.jsx src/components/SessionEditModal.test.jsx`
Expected: PASS (3 + 2).

- [ ] **Step 9: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/components/ReportPanel.jsx web/src/components/ReportPanel.test.jsx web/src/components/SessionEditModal.jsx web/src/components/SessionEditModal.test.jsx
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): redesigned report — custom range, search, table, CSV, edit modal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: SettingsPanel + ManagerDashboard shell + final wiring

Restyle settings, compose the manager dashboard from the new components, remove the old LivePanel import, and verify the whole app builds and all screens render. Deliverable: complete redesigned app, green suite, successful production build.

**Files:**
- Rewrite: `web/src/components/SettingsPanel.jsx`, `web/src/components/ManagerDashboard.jsx`
- Delete (if not already): `web/src/components/LivePanel.jsx`, `LivePanel.test.jsx`
- Test: `web/src/components/SettingsPanel.test.jsx` (create)

**Interfaces:**
- Consumes: `Button`, `useToast`, `LiveFloor`, `ReportPanel`, `SettingsPanel`, `api`.
- Backend: `GET /admin/settings`, `PUT /admin/settings`.
- Produces:
  - `SettingsPanel({ api })` — `.field` form: timezone, daily_target_hours, max_session_hours, work_start; success toast "تم الحفظ"; error mapping (INVALID_TIMEZONE/INVALID_HOURS/INVALID_WORK_START).
  - `ManagerDashboard({ api })` — renders `<LiveFloor api/>`, `<ReportPanel api/>`, `<SettingsPanel api/>` stacked in `.grid`.

- [ ] **Step 1: Write failing SettingsPanel test**

`web/src/components/SettingsPanel.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

describe("SettingsPanel", () => {
  it("loads settings then saves via PUT", async () => {
    const api = {
      get: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00" })),
      put: vi.fn(async () => ({ timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00" })),
    };
    wrap(<SettingsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/admin/settings"));
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/admin/settings", expect.objectContaining({ timezone: "Asia/Riyadh" })));
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/SettingsPanel.test.jsx`
Expected: FAIL (current SettingsPanel not wrapped in toast / markup differs) or resolves — if it passes as-is, still do Step 3 to restyle.

- [ ] **Step 3: Rewrite SettingsPanel.jsx**

```jsx
import { useEffect, useState } from "react";
import Button from "./Button.jsx";
import { useToast } from "./ToastContext.jsx";

export default function SettingsPanel({ api }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => setError("حدث خطأ، حاول مرة أخرى")); }, []);
  if (!s && !error) return <div className="panel muted">جارٍ التحميل…</div>;
  if (!s) return <div className="panel error">حدث خطأ، حاول مرة أخرى</div>;

  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  async function save() {
    setError("");
    try {
      const saved = await api.put("/admin/settings", {
        timezone: s.timezone,
        daily_target_hours: Number(s.daily_target_hours),
        max_session_hours: Number(s.max_session_hours),
        work_start: s.work_start || null,
      });
      setS(saved); toast("تم الحفظ");
    } catch (e) {
      setError(e.code === "INVALID_TIMEZONE" ? "المنطقة الزمنية غير صحيحة"
        : e.code === "INVALID_HOURS" ? "الساعات غير صحيحة"
        : e.code === "INVALID_WORK_START" ? "وقت البداية غير صحيح"
        : "حدث خطأ، حاول مرة أخرى");
    }
  }

  return (
    <section className="panel" style={{ maxWidth: 480 }}>
      <div className="panel-h"><h2>الإعدادات</h2></div>
      <div className="field"><label>المنطقة الزمنية</label><input value={s.timezone} onChange={set("timezone")} /></div>
      <div className="field"><label>الهدف اليومي (ساعات)</label><input type="number" step="0.5" value={s.daily_target_hours} onChange={set("daily_target_hours")} /></div>
      <div className="field"><label>حد الجلسة (ساعات)</label><input type="number" step="0.5" value={s.max_session_hours} onChange={set("max_session_hours")} /></div>
      <div className="field"><label>بداية الدوام (HH:MM)</label><input value={s.work_start ?? ""} onChange={set("work_start")} /></div>
      {error && <div className="field"><span className="err">{error}</span></div>}
      <div className="dlg-a"><Button onClick={save}>حفظ</Button></div>
    </section>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/SettingsPanel.test.jsx`
Expected: PASS (1).

- [ ] **Step 5: Rewrite ManagerDashboard.jsx**

```jsx
import LiveFloor from "./LiveFloor.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

export default function ManagerDashboard({ api }) {
  return (
    <div className="grid">
      <LiveFloor api={api} />
      <ReportPanel api={api} />
      <SettingsPanel api={api} />
    </div>
  );
}
```

- [ ] **Step 6: Delete LivePanel if it still exists**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git rm --ignore-unmatch web/src/components/LivePanel.jsx web/src/components/LivePanel.test.jsx
```

- [ ] **Step 7: Full suite + production build**

Run: `cd web && npx vitest run && npm run build`
Expected: ALL tests PASS; build succeeds; `../public/index.html` written. Confirm no import references `LivePanel` anymore: `grep -rn LivePanel web/src` returns nothing.

- [ ] **Step 8: Commit**

```bash
cd /Users/mohammedelkasim/Downloads/noursky-timeclock
git add web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx web/src/components/ManagerDashboard.jsx
git -c user.name="Mohammed Nour" -c user.email="azer9nor@gmail.com" commit -m "feat(web): restyled settings + composed manager dashboard, drop LivePanel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §4 light-theme tokens, fonts, RTL, Western digits → Task 1 (styles.css, index.html). ✅
- §5/§6 architecture + files → Tasks 1-7 cover every listed file. ✅
- §7 TopBar (dev role control, no theme) → Task 3. ✅
- §7 Employee hero (timer, meta, progress, Start/Stop, week total) → Task 4. ✅
- §7 KpiRow + LiveFloor (working/offline, server-time) → Task 5. ✅
- §7 ReportPanel (custom range, search, table, CSV via api.download, edit) → Task 6. ✅
- §7 SessionEditModal (reason gate, INVALID_TIMES) → Task 6. ✅
- §7 SettingsPanel + ManagerDashboard shell → Task 7. ✅
- §8 Toast, loading/empty/error, responsive → Task 2 (toast) + per-panel states + ported CSS. ✅
- §9 deferred items → none built; not in any task (correct). ✅
- §10 testing → each component has a Vitest test; build gates in Tasks 1,3,7. ✅

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Every code step has full code. The only conditional is Task 5 Step 10's ruling about delete ordering, which is spelled out, not a placeholder.

**3. Type consistency:**
- `Button({onClick,loading,disabled,variant,size,children,type})` — defined Task 2, used identically in Tasks 4,6,7. ✅
- `useToast()` → `(msg)=>void` — Task 2, used in 4,6,7. ✅
- `Icon({name,size})` — Task 1, used in 2,4,6. ✅
- `formatClock(sec)→{h,mm,ss}` — Task 1, used in 4. ✅
- `KpiRow({live})`, `LiveFloor({api})` — Task 5, used in 7. ✅
- `ReportPanel({api})` + `todayRange/weekRange/monthRange`, `SessionEditModal({api,session,onClose,onSaved})` — Task 6, used in 7. ✅
- `SettingsPanel({api})`, `ManagerDashboard({api})` — Task 7. ✅
- `EmployeeScreen({api,user})` — Task 4, used by App in Task 3 (App passes `user`). ✅
- `api.download(path,filename)` — exists in api.js (added during deploy phase); consumed in Task 6. ✅

No gaps found.
