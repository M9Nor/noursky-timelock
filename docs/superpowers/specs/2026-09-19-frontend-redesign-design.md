# NourSky TimeClock — Frontend Redesign (Design Spec)

> **Status:** Approved for planning · 19 September 2026
> **Owner:** NourSky Digital Agency
> **Type:** Architectural (frontend rebuild on a new design system; no backend changes)

## 1. Goal

Re-skin the existing, already-deployed React frontend with the professional
design supplied as a static HTML mockup (`docs/design-reference.html`), so the
product looks finished and is ready to wire into GHL. **Frontend only — zero
backend changes.** Every screen must run on the data the current backend
already returns. Design elements that need data the backend does not provide
are deferred and listed in §9 (Future Work), not built now.

Explicitly out of scope for this phase: dark mode, breaks/Pause, day-timeline
with breaks, per-day week bars, per-employee weekly heatmap, requests,
approvals, leave, employee deactivation, lateness calculation, and a
first-in/last-out column. All are captured in §9.

## 2. Design source

`docs/design-reference.html` is the visual source of truth: a self-contained
mockup with the full NourSky design system (IBM Plex Sans Arabic, brand
tokens, buttons, chips, panels, KPIs, live floor, table, dialogs, toast,
responsive rules). We port its **look** (CSS + markup structure) onto the
existing React components, keeping the existing app logic (auth, timers, API).
We take only the light-theme tokens; the dark-mode blocks are dropped.

The mockup's own JS is a standalone demo with seeded fake data (breaks,
requests, approvals, a 10-person team). We do NOT port that JS or its data
model. We port styling and the DOM structure of the screens we keep.

## 3. What the current backend provides (the hard boundary)

From `src/server.js` (unchanged). Every UI element must map to one of these.

- `POST /auth/sso` / `POST /auth/dev-login` → `{ token, user: {uid, loc, role, name, email} }`
- `GET /me/status?since=` → `{ open_session: {id, started_at} | null, worked_sec, server_time }`
- `POST /session/start` → `201 { id, started_at }` · `409 SESSION_ALREADY_OPEN`
- `POST /session/stop` → `200 { id, started_at, ended_at, duration_sec }` · `409 NO_OPEN_SESSION`
- `GET /admin/live` → `{ server_time, employees: [{user_id, name, email, session_id, started_at}] }`
- `GET /admin/report?from=&to=` → `{ from, to, timezone, daily_target_hours, employees: [{user_id, name, email, worked_sec, sessions_count, days_present, auto_closed}] }`
- `GET /admin/sessions?from=&to=&user_id=` → `{ sessions: [{id, user_id, name, started_at, ended_at, duration_sec, closed_by}] }`
- `PATCH /admin/sessions/:id` `{started_at, ended_at, reason}` → updated session
- `GET /admin/export.csv?from=&to=` → CSV (auth via `api.download`)
- `GET /admin/settings` / `PUT /admin/settings`

**Data the backend does NOT provide** (so these mockup elements are cut, see §9):
per-day breakdowns, break/segment data, first-in/last-out per employee,
lateness, request/approval/leave records, employee active-toggle endpoint.

## 4. Global constraints (verbatim, bind every task)

- Node ≥ 20, ESM, plain JavaScript (no TypeScript). React 18 + Vite.
- **Arabic RTL** (`dir="rtl" lang="ar"`). Numbers always **Western digits**
  (1,2,3) — never Arabic-Indic. Use `tabular-nums`, `Intl` locale `en`/`en-GB`,
  `toFixed`, plain `String`/`padStart` — never an Arabic-Indic numbering locale.
- **Light theme only.** Port the `:root` light tokens from the mockup verbatim.
  Do NOT include `@media (prefers-color-scheme: dark)`, `[data-theme="dark"]`,
  the theme toggle button, or the pre-paint theme script. `color-scheme: light`.
- Brand tokens (verbatim from mockup `:root`): `--accent:#6C5CE7`,
  `--pink:#E91E63`, `--head:#1A1A2E`, `--bg:#F7F7FB`, `--panel:#FFFFFF`,
  `--sunken:#F4F0FF`, `--ink:#20203A`, `--muted:#5A5A72`, `--line:#D9D6EA`,
  `--pos:#1E7F4F`, `--neg:#C0392B`, `--warn:#8A6508`, radii `--r-lg:20px`
  `--r-md:14px` `--r-sm:10px`, font `IBM Plex Sans Arabic`.
- Font loaded from Google Fonts (`fonts.googleapis.com`) exactly as the mockup's
  `<link>` tags, added to `web/index.html`.
- **Token in memory** (React state/ref), never localStorage. The only
  localStorage use permitted is per-viewer UI preference, and since dark mode is
  cut, there is no localStorage use in this phase.
- **Live timers derive from `server_time`** via `serverOffset`/`nowWithOffset`,
  never the raw client clock.
- On `401`: silent SSO re-handshake once (existing behavior in `App.jsx`), then
  error screen. Keep dev-login gating (`import.meta.env.DEV`) and the
  production build fix (`build-web.mjs`, `vite build --mode production`) intact.
- Errors are `{ error: "CODE" }`; UI maps codes to Arabic messages already
  defined. No new error codes (no backend change).
- `archive/cloudflare-worker/` is reference only. Never edit it.
- The frontend Vitest suite must stay green and grow with new components.

## 5. Architecture

Same shape as today: a Vite SPA in `web/`, built to `../public`, served static
by Hono. `App.jsx` still owns auth + role routing + the 401-wrapped `api`
client. The rebuild replaces the presentation layer only.

```
App.jsx  (auth, role routing, api wrapper — mostly unchanged)
 ├─ TopBar            (brand, date, role segmented control [dev], no theme btn)
 ├─ EmployeeScreen    (hero clock, today/week totals, day log)
 │    └─ Button, Icon
 └─ ManagerDashboard  (tab or single-scroll: KPIs, LiveFloor, Report table, Settings)
      ├─ KpiRow
      ├─ LiveFloor     (working / offline lanes)
      ├─ ReportPanel   (period filter incl. custom range, search, table, CSV)
      │    └─ SessionEditModal
      └─ SettingsPanel
 Shared: Icon (inline SVG set), Toast, formatting helpers (time.js)
```

**Role routing:** unchanged — `user.role === "manager"` → ManagerDashboard,
else EmployeeScreen. Server-side `managerOnly` already enforces access; the UI
mirrors it. The mockup's role segmented control in the top bar is a **dev-only
convenience** (same spirit as dev-login): show it only when
`import.meta.env.DEV`; in production the role comes from the token and the
control is hidden.

## 6. File structure

**New / rewritten (all under `web/src/`):**
- `styles.css` — full rewrite: light tokens + base + every component class
  ported from the mockup (topbar, panel, btn, chip, kpis, floor, table,
  dialog, toast, responsive). One stylesheet, class-based (no CSS framework).
- `components/Icon.jsx` — inline SVG set (play, stop, search, download, plus,
  check, x) as a small `{name}` component. Ported from the mockup's `ICON`.
- `components/TopBar.jsx` — brand, today label (`Intl` ar with latn digits),
  dev-only role segmented control, no theme toggle.
- `components/Toast.jsx` + a tiny toast hook/context — transient status messages.
- `components/Button.jsx` — rewritten to the mockup's `.btn` variants
  (primary/ghost/danger, lg/sm), loading + disabled.
- `components/EmployeeScreen.jsx` — hero (greeting, status chip, big timer,
  meta: today target / remaining / expected-out, progress bar, Start/Stop),
  week total (numeric, not per-day bars), today log (from the open/closed
  session data available). Breaks, day-timeline, Pause: omitted.
- `components/ManagerDashboard.jsx` — shell: KpiRow + LiveFloor + ReportPanel +
  SettingsPanel. (Approvals/heatmap sections omitted.)
- `components/KpiRow.jsx` — KPIs computed from `/admin/live` + `/admin/report`:
  “داخل الدوام الآن”, “إجمالي الموظفين”, “جلسات مغلقة تلقائياً”, “أيام حضور
  (المجموع)” — only values derivable from current data (see §7).
- `components/LiveFloor.jsx` — two lanes: “داخل الدوام” (open session, live
  duration) and “غير متصل”. (No break/done/leave lanes — no data.)
- `components/ReportPanel.jsx` — period filter (Today / Week / Month / **Custom
  range**), search box, table (employee, hours, target, completion%, days,
  auto-closed), CSV export via `api.download`, row click → session detail →
  edit. Columns dropped vs mockup: الدخول/الخروج/الاستراحات (no data).
- `components/SessionEditModal.jsx` — restyled to `<dialog>`/`.dlg` look;
  start/end/reason, mandatory reason, INVALID_TIMES handling.
- `components/SettingsPanel.jsx` — restyled `.field` form; timezone, daily
  target, max session, work start.
- `time.js` — extended with any formatting helpers the new UI needs
  (e.g. `formatClock` H:MM:SS split for the hero, `formatHM` H:MM). Keep the
  existing `formatDuration`, `formatHours`, `serverOffset`, `nowWithOffset`.

**Unchanged logic:** `api.js`, `auth.js`, `App.jsx` (only its rendered children
and the dev-only role control change; the auth/401/routing logic stays).

**Backend:** untouched. `src/server.js`, `schema.sql`, `scripts/*` unchanged.

## 7. Screen-by-screen mapping (design → real data)

### TopBar
- Brand “NourSky / TimeClock”, today label via
  `Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', {weekday,day,month})`.
- Dev-only role segmented control (موظف / المدير) — `import.meta.env.DEV` only.
- **Cut:** theme toggle button.

### Employee screen
- **Hero:** greeting “مرحباً، {name}” from token; status chip
  (داخل الدوام / لم يسجّل الدخول) from `open_session`; big timer H:MM:SS from
  `nowWithOffset(offset) - open_session.started_at`; meta = ساعات اليوم
  المطلوبة (`daily_target_hours` from settings — fetch once; employee has no
  settings route, so use a sensible default of 8 and note it), المتبقي,
  الخروج المتوقع; progress bar = today worked / target; Start/Stop button
  with loading.
- **Today total / Week total:** numeric (`worked_sec` today; week via a second
  `/me/status?since=` call for the last 7 days). No per-day bars (deferred).
- **Day log:** from the current open/closed session (start time, and on stop a
  “انتهى الدوام” entry). Minimal — the backend keeps only sessions, so the log
  shows session boundaries, not breaks.
- **Cut:** breaks meta, day-timeline track, Pause button, requests panel.

### Manager dashboard
- **KpiRow** from `/admin/live` + `/admin/report`:
  - داخل الدوام الآن = count of employees with a `session_id` in `/admin/live`.
  - إجمالي الموظفين = employees length.
  - جلسات مغلقة تلقائياً = sum of `auto_closed` over the report period.
  - أيام الحضور (إجمالي) = sum of `days_present`, or drop the 4th KPI if it
    reads oddly — implementer picks the clearest of these that uses real data.
  - **Cut:** متأخرون (no lateness), طلبات معلّقة (no requests).
- **LiveFloor:** lanes “داخل الدوام” (with live duration from `started_at`) and
  “غير متصل”. Avatar = first letter of name. 30s poll + 1s tick, both cleaned
  up on unmount, server-time based.
- **ReportPanel table:** columns الموظف / ساعات العمل / الهدف / الإنجاز٪
  (colour 90/60 thresholds) / أيام الحضور / مغلقة تلقائياً. Period filter adds
  a **custom range** (two date inputs → from/to unix seconds). Search filters
  by name client-side. CSV via `api.download`. Row click loads
  `/admin/sessions?...&user_id=` and shows sessions with an edit action.
  **Cut:** الدخول / الخروج / الاستراحات columns.
- **SessionEditModal:** `<dialog>` styling; start/end (datetime-local), reason
  (mandatory → “سبب التعديل مطلوب”), INVALID_TIMES → “الأوقات غير صحيحة”.
- **SettingsPanel:** restyled; timezone / daily_target_hours / max_session_hours
  / work_start; success “تم الحفظ”; error-code→Arabic mapping as today.

## 8. Cross-cutting behavior

- **Toast:** replace inline error text with the mockup's toast for transient
  successes (“بدأ دوامك…”, “تم الحفظ”, “تم تصدير الملف”). Keep an inline error
  line for form validation.
- **Loading/empty/error states:** every panel shows “جارٍ التحميل…” while
  fetching, a `.empty` state when there is nothing, and the standard
  “حدث خطأ، حاول مرة أخرى” on failure.
- **Responsive:** port the mockup's breakpoints (1080/900/600). Must work at
  phone width with no horizontal page scroll; runs inside a GHL iframe.
- **Accessibility:** keep the mockup's `.sr`, `aria-*`, focus-visible outline,
  skip link.

## 9. Future work (deferred — NOT built this phase)

Recorded here so nothing is lost. Each needs backend work (schema and/or
endpoints) before its UI can be real:

1. **Dark mode** — re-add the mockup's dark tokens, `[data-theme]`, toggle,
   pre-paint script, localStorage `tc-theme`. (Frontend-only; deferred by choice.)
2. **Breaks / Pause** — new `session_segments` table (work/break intervals),
   start/pause/resume/stop endpoints; enables the hero breaks meta, the
   day-timeline track, and the breaks column.
3. **Per-day breakdowns** — `GET /me/daily` and `GET /admin/daily` aggregations
   by local day; enables employee week bars and the manager weekly heatmap.
4. **Lateness** — compute from `work_start`; enables the “متأخرون” KPI, the late
   chip, and the lateness column/filter.
5. **First-in / last-out column** — from sessions grouped by local day.
6. **Requests + approvals** — `requests` table + endpoints + manager approval UI
   (the mockup's request dialog, “طلباتي”, “طلبات بانتظار موافقتك”).
7. **Leave** — leave records + the `leave` status/lane/chip.
8. **Employee deactivation** — `PATCH /admin/employees/:id` toggling `is_active`
   (column already exists) + a dashboard control.

## 10. Testing

- **Vitest + React Testing Library** for every component with logic: EmployeeScreen
  (start/stop, timer, states), LiveFloor (working/offline split), ReportPanel
  (rows render, completion colour, custom range → correct from/to, CSV calls
  `api.download`), SessionEditModal (reason gate, PATCH), KpiRow (counts),
  Toast (shows/hides), time.js helpers. All API mocked; no DB.
- The full suite must pass and the production build (`npm run build`,
  `--mode production`) must succeed with no dark-mode/theme code shipped.
- Manual visual check via the local mock backend used earlier (light theme,
  RTL, Western digits, phone width).

## 11. Self-review

- **Placeholders:** none — every screen maps to a real endpoint in §3; anything
  without data is in §9, not the build.
- **Consistency:** §7 columns/KPIs match §3 data exactly; cut items match §9.
  No dark mode anywhere (§4 forbids it, §9 defers it).
- **Scope:** single frontend rebuild, no backend change — fits one plan.
- **Ambiguity:** employee daily target has no employee-facing settings route;
  §7 fixes it to default 8 with a note, rather than adding a backend route.
