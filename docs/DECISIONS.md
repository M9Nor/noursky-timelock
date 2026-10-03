# DECISIONS — NourSky TimeClock

Append-only architectural/technical decision record. Newest on top.
Format: **Date — Decision** · Reason · Alternatives rejected.

---

### 2026-10-03 — Arabic + English
The UI is now bilingual (Arabic RTL, English LTR). Company language is a setting
(`settings.locale`, default Arabic); each employee can override it (`employees.locale`,
`PUT /me/locale`, language button in the top bar). Login returns `user.locale`. Numbers stay
Western digits in both languages. The GHL install/OAuth pages are bilingual by `Accept-Language`.
Work and break times use time pickers instead of free text.
- **Home-made i18n** (`web/src/i18n.jsx`: provider + `t()`, dictionaries in `web/src/locales/ar.js`
  and `en.js`) instead of a library: ~170 strings, no new dependency, no bundle cost. Guard tests
  keep both dictionaries in sync and scan the source for hard-coded text.
- **Company default + personal override** so a manager can pick the team language while an
  individual employee can still choose theirs.
- **Install pages by `Accept-Language`** — there is no logged-in user at that point.
- **Rejected:** react-i18next (dependency and setup for ~170 strings); auto-detecting the browser
  language for the app (GHL users' browsers do not reflect the language the company wants);
  language per location only (no personal choice).
- **Migration 006** (`settings.locale`, `employees.locale`) must be applied in production before
  the code is deployed.

### 2026-09-29 — Activity from GHL is evidence and alerts, never the clock
Owner wanted attendance driven by GHL activity (audit logs). Decision: manual start/stop
stays the record of truth; activity only raises in-app alerts and marks sessions for the
manager to review — nothing is started, stopped or deducted automatically.
- **Source: official webhooks** (`OutboundMessage` carries `userId`), via our Marketplace
  app with a read-only scope. **Rejected:** GHL Audit Logs (no public API or scope; the
  internal endpoint the GHL UI uses is undocumented and unstable), polling the API.
- **In-app alerts only.** Rejected GHL workflow Inbound Webhook alerts (premium trigger,
  per-execution cost; owner wants zero cost).
- **Privacy:** metadata only (who, when, kind, message type, source) — never content; raw
  rows deleted after 90 days; per-session summaries and alerts kept.
- **A GHL signature proves origin, not recipient:** GHL signs every Marketplace app's
  webhooks with one Ed25519 key, so install/uninstall must match `GHL_APP_ID` and activity
  is deduped on `messageId`.
- **Test signing key** is committed on purpose and accepted only when `NODE_ENV` is
  development/test (fail closed).
- **Alert uniqueness** uses numeric generated flags + composite UNIQUE keys
  (`idle_open_flag`, `nci_open_flag`): MariaDB 11.8 rejects STORED generated columns with
  a string IF result (ERROR 1901).

### 2026-09-28 — Break modes: fixed windows are recorded, not computed
Breaks became one setting, `break_mode` = off / fixed / flexible (owner-approved). An unpaid
fixed window is written as a `breaks` row (`kind='fixed'`) once it begins for an open
session (or a manager edit newly covers it), instead of being computed on read from the
current policy.
- **Reason:** payroll history must not move when a manager changes the lunch hour. Stored
  rows also reuse every existing worked-time query, clipping and CSV path unchanged.
- **Rules:** at most one fixed row per session per local day (first recorded wins — a
  same-day window change otherwise double-deducts permanently); a policy applies only to
  windows starting after it was saved (`break_policy_since`); PUT and PATCH record begun
  windows before changing anything; recorded fixed rows can't be removed from the UI.
  Unpaid means deducted even if the employee worked through it (standard auto-deduct);
  paid deducts nothing and is shown for information.
- **Kept for the deploy window:** `breaks_enabled` stays in sync with `break_mode =
  'flexible'`, and a body with only `breaks_enabled: true` maps to `flexible`.
- **Rejected:** computing fixed deductions on read (retroactive on every policy change);
  a paid/unpaid-only toggle with no window (the paid case alone tracks nothing); storing a
  per-session total (breaks the report's window clipping).

### 2026-09-27 — Breaks and note on stop: computed on read, enforced by the server
- **Worked time is never stored.** `duration_sec` keeps its meaning (wall-clock length);
  `break_sec` is computed on read and every worked-time sum subtracts breaks clipped to the
  session and the query window. A manager edit that shortens a session therefore clips its
  breaks automatically; a break left open on a closed session is ended at the session end
  by `autoCloseStale`.
- **One open break per session** is a DB constraint (`open_flag` + UNIQUE), same pattern as
  sessions. Break start/stop use a transaction and lock the session row first (same lock
  order as `/session/stop`).
- **A break can always be ended**, even after the manager disables breaks — otherwise an
  employee could be stuck mid-break.
- **Note policy is enforced by the server** (`400 NOTE_REQUIRED`, session stays open); the
  UI's copy of the policy is a convenience and self-corrects on that error. With the
  policy `off` a sent note is discarded, not stored.
- **CSV cells starting with = + - @ tab CR are prefixed with `'`** — notes are employee
  free text and would otherwise run as Excel formulas.
- **Employee live totals extrapolate from `server_time`** (server numbers are exact at
  that instant; the client adds only the seconds since, and nothing during a break). The
  old formula added the full session again on top of `worked_sec`.
- **Rejected:** storing worked seconds on the session (goes stale on every manager edit
  and every break); a separate `break_sec` column maintained by triggers or app code
  (two sources of truth); a UI-only required note (bypassable, and a stale policy would
  silently let stops through).

### 2026-09-27 — Local days use the offset in force on each date (DST-safe)
Report `late_days`/`days_present` and the per-session `late_by_sec` map every timestamp
with the UTC offset in force at that instant. `src/tz.js` finds the offset changes inside
the query window (daily step + bisection, capped at ~10 years) and emits a SQL
`CASE WHEN col >= <change> THEN <off> … END`; with no change it is a plain number, so the
common case is unchanged. Queries also gained a sargable `started_at` pre-filter padded
by two days so the `(location_id, started_at)` index narrows the scan first.
- **Reason:** a single offset snapshot taken "now" shifted every session on the far side
  of a DST change by an hour — a 08:30 winter arrival in Berlin was reported as a 09:30
  late one. Any client in a DST zone would see wrong lateness.
- **Rejected:** MySQL `CONVERT_TZ()` with named zones (needs the tz tables loaded, not
  guaranteed on Hostinger's shared MariaDB); pulling all rows into JS to bucket by day
  (moves aggregation out of SQL and grows with history).
- Also fixed `tzOffsetSec()` at the source (it compared whole-second Intl output with a
  millisecond-carrying Date and could return 1 second short), removing the call-site
  workaround in the report handler.

### 2026-09-24 — سياسات الدوام تُضبط لكل حساب، لا تُفرض على الجميع
`work_start` + `late_grace_minutes` يحسبان التأخير، والهدف اليومي يُقرأ من إعدادات
الحساب بدل رقم ثابت بالواجهة.
- **السبب:** الأداة منتج لعدة شركات باختلاف أنماط عملها؛ ما يناسب فريقاً مكتبياً لا
  يناسب فريقاً عن بُعد. جعل السياسة إعداداً يغطي الجميع بنواة واحدة.
- **المرفوض:** التتبع التلقائي بالنشاط (يقيس فتح التبويب لا العمل)، وGPS/Geofence
  (كلفة خصوصية بلا فائدة لفرق مكتبية ومبيعات).

### 2026-09-19 — Shared project-context system lives in the repo
Store all cross-session context in `CLAUDE.md` + `docs/PROGRESS.md` + `docs/DECISIONS.md`,
with `/handoff` and `/resume` slash commands and a SessionStart hook.
- **Reason:** the project is worked on from multiple Claude Code accounts and chat
  history does not transfer; context must be in the repo and continuously updated.
- **Rejected:** relying on per-account memory or chat history (does not transfer);
  an external doc/wiki (drifts from the code, extra tooling).

### 2026-09-19 — Deploy via Hostinger Git auto-deploy (push to `main`)
Hostinger's Node Web App is connected to GitHub `M9Nor/noursky-timelock`, auto-deploying
on push to `main`; `npm install` runs `postinstall` (`scripts/build-web.mjs`) to build the
SPA into `public/`, then `npm start`.
- **Reason:** simplest reproducible deploy on the hosting NourSky already owns; no
  separate CI needed; the build runs on the host so `public/` stays out of git.
- **Rejected:** committing `public/` (build artifacts in git); a GitHub Actions →
  FTP/SSH pipeline (more moving parts than needed now); manual zip upload (not reproducible).

### 2026-09-19 — Frontend must build in production mode on the host
`scripts/build-web.mjs` installs `web/` dev deps with `--include=dev` (host installs in
prod mode and would skip vite) but runs the build with `NODE_ENV=production` +
`vite build --mode production`.
- **Reason:** installing in prod mode omitted `vite` (`command not found`); building in
  dev mode shipped a development bundle where `import.meta.env.DEV` was true, exposing the
  **dev-login screen in production** (a security issue). Splitting the envs fixes both.
- **Rejected:** committing `node_modules` or `public/`; moving vite to dependencies
  (pollutes runtime deps); leaving the build in dev mode (ships dev-login to prod).

### 2026-09-19 — Standalone git repo for the project
`git init` inside the project folder instead of using the pre-existing home-level repo.
- **Reason:** the project sat inside a large, unrelated home-directory git repo that did
  not track it; a dedicated repo gives clean history for GitHub/Hostinger.
- **Rejected:** working inside the home-level repo (mixes unrelated files/history).

### 2026-09-19 — Dev-only login + dev-only role switch, gated by `import.meta.env.DEV` / `NODE_ENV`
`POST /auth/dev-login` (backend, 404 in production) and the TopBar role segmented control
(frontend, only when `import.meta.env.DEV`) let us build/test without a live GHL SSO.
- **Reason:** GHL SSO only works inside a GHL iframe; we need local development and
  automated tests without it, but it must be impossible to reach in production.
- **Rejected:** a shared "test mode" flag readable in prod (unsafe); no dev path at all
  (blocks all local UI work and tests).

### 2026-09-19 — Frontend redesign: light theme only, existing backend only
Re-skin with the supplied NourSky design (`docs/design-reference.html`) using only data
the current backend returns; defer everything else to a future-work list (spec §9).
- **Reason:** get a finished, shippable UI fast and ready to wire into GHL, without a
  backend change cycle. Dark mode and richer features add schema/endpoints.
- **Rejected:** building the full mockup (breaks/Pause, requests, approvals, leave,
  per-day charts) now — needs new tables/endpoints and delays GHL go-live; shipping dark
  mode now (deferred by the owner).
- **Adopted design tokens verbatim** from the mockup, including `--warn:#8A6508` (darker
  for contrast) which differs from `#B8860B` in older CLAUDE.md prose.

### 2026-09-19 — CSV export goes through the authenticated api client, not a bare link
`api.download(path, filename)` fetches with the bearer header and triggers a blob download.
- **Reason:** the session token lives in memory (not a cookie), so a plain `<a href>` to
  `/admin/export.csv` would hit the `authed, managerOnly` route unauthenticated and 401.
- **Rejected:** a bare anchor link (fails auth); storing the token in a cookie/localStorage
  (violates the token-in-memory rule).

### 2026-09-19 — Context-only commits and deploy triggers
Keep `docs/**` and `CLAUDE.md` commits small; note a desire for `paths-ignore` so they
don't rebuild. Hostinger's Git deploy UI does not expose paths-ignore, so context commits
currently trigger a harmless rebuild.
- **Reason:** avoid unnecessary rebuilds from documentation-only changes.
- **Rejected:** a GitHub Actions deploy with `paths-ignore` (would replace Hostinger's
  built-in Git deploy — larger change than warranted now). Revisit if rebuilds become costly.

## 2026-09-30 — Neutral public paths for the GHL webhook and OAuth callback
- **Decision:** `POST /ghl/webhook` → `POST /webhooks/events`, `GET /ghl/oauth/callback` → `GET /oauth/callback`.
- **Reason:** the GHL Marketplace app settings reject any redirect/webhook URL that mentions HighLevel ("ghl"),
  so the old paths could not be registered. Nothing was registered or installed on the old paths yet, so no alias is kept.
- **Rejected:** a subdomain or query-string trick to keep the old names — more moving parts, same result.

## 2026-10-02 — Only events with a `userId` count as a person's activity
- **Decision:** phase B treats an `OutboundMessage` as an employee's activity only when it carries a `userId`.
  Events without one are stored but never move anyone's "last activity".
- **Reason:** verified on Innova — an automatic Instagram reply arrived with no `userId`, while messages typed
  by a team member (Instagram, Email) carried theirs. `source` was `app` for both, so it cannot tell them apart.
- **Open:** bulk/workflow sends, SMS, WhatsApp, calls, comments and the mobile app are not connected on Innova and
  remain unobserved (spec §2.1). A bulk send started by a person may carry their `userId`; check before relying on it.
- **Rejected:** filtering on `source` (same value for both); keyword or timing heuristics (fragile, opaque).

## 2026-10-02 — Marketplace 2.0.0 and a dedicated client key
- **Decision:** the activity-monitoring app version was published as 2.0.0, and a new client key
  (`timeclock-server`) was made the default; its id/secret are in Hostinger env only.
- **Reason:** GHL forces a major version when a scope is added (existing installs keep 1.0.0 until updated in
  each Sub-Account). The original key's secret was not recoverable, and the OAuth exchange must use the default key.
- **Rejected:** keeping the old key (secret lost); a minor version (GHL disallows it for scope changes).
- **Note:** in hPanel, "Add environment variable" only stages a change — it is saved by **Apply changes**,
  followed by a redeploy.

## 2026-10-02 — Phase B: one alert, idle as information, absent settings fields are kept
- **Decision:** phase B raises only "working, not clocked in", and only inside working hours
  (`work_start`–`work_end` on `work_days`, location time). Idle time is shown (live chip, session
  columns) but never alerts; the idle alert and "end at last activity" are deferred (spec §11).
  `PUT /admin/settings` keeps any field absent from the body.
- **Reason:** on Innova only Instagram and Email reach us, so silence is weak evidence; an alert with
  an "end session" button is the closest thing to a pay deduction. Out-of-hours work is not the
  manager's concern (owner). "Absent = keep" stops an older page from resetting newer fields.
- **Rejected:** the 2026-09-29 idle alert as drafted; deriving the end of day from `daily_target_hours`
  (approximate); a 3-events-in-30-minutes trigger (owner preferred working hours).

## 2026-10-02 — Phase B review refinements: stale-proof alert, guarded summaries
- **Decision:** the not-clocked-in alert opens with one `INSERT IGNORE ... SELECT ... WHERE NOT EXISTS`
  and the rule is "no session open, and none ending after the event" (was: none covering it); a
  duplicate delivery (nothing stored) skips the alert step. A stored session summary needs at least one
  event at the location in the 24 h before the session ended, else it stays NULL. A manager edit refills
  that session's summary directly, at any age, if monitoring was ever on there.
- **Reason:** a separate read then insert let a clock-in racing the event leave a stale open alert, and a
  late or repeated delivery of an old event could open one after the shift ended. Without the guard an
  outage (location not on 2.0.0, GHL down) was stored forever as "0 activity, long idle". The periodic
  pass only looks 7 days back, so an edit of an older session left "—" for good.
- **Rejected:** keeping the "covering" rule with a re-check after insert (still racy); a time window on
  the edit refill (summaries are kept forever); recomputing stored summaries when events arrive late.

## 2026-10-02 — Dismiss does not stick; noted alerts stay visible after clock-in
- **Decision:** a dismissed alert does not suppress later alerts — the next qualifying event opens a
  new one (no code change). The manager's alerts panel also lists, read-only under "ملاحظات الموظفين",
  alerts resolved by clocking in during the last 24 hours that carry an employee note
  (`GET /admin/alerts?status=resolved`, rows now include `resolved_at`). The list order is
  `from_at DESC, id DESC`; the session-summary pass takes the most recently ended sessions first.
- **Reason:** an employee who writes a note and then clocks in resolves the alert, and the manager
  would otherwise never see the explanation. Ordering the summary pass by `ended_at DESC` keeps new
  sessions from starving behind older ones the no-events guard keeps refusing.
- **Rejected:** suppressing alerts for the rest of the day after a dismiss (owner prefers every new
  stretch of unclocked work to be raised); showing notes in the session detail (the alert has no session).

## 2026-10-02 — Phase C: the idle alert, after all
- **Decision:** an idle alert to the manager and the employee once a clocked-in employee has no activity
  for longer than `idle_minutes` (now 1–240). It stays open for the manager until dismissed; the
  employee sees it while it is ongoing and can answer with a note. Delivery is in the app: both screens
  refresh every minute and the tab title shows ⚠️. A detector runs every 60 s; activity or a session end
  closes the stretch; a late event inside the gap resolves it `late_activity`.
- **Reason:** the owner wants to be told, not to look for a chip; breaks, the 24 h outage guard and the
  late-event rule keep it fair. "End at last activity" stays deferred (no automatic pay effect).
- **Rejected:** auto-closing the alert on resume (the manager would miss the stretch); browser
  notifications and GHL SMS/WhatsApp (permission prompts inside the iframe; cost).
