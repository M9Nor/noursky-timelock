# PROGRESS — NourSky TimeClock

Living handoff log. Read this + `DECISIONS.md` at the start of every session.

## Current State
_(overwrite each update)_
- **Branch:** `main` — activity monitoring phases **A, B and C** and **Arabic + English** (merged
  `147c41c`, migration 006 applied 2026-10-03) are all live. Marketplace **2.0.1** published 2026-10-03
  (patch, reaches 2.x installs automatically): the GHL sidebar label is now always **"TimeClock"**
  (Custom Page title; previously "الدوام"). English client guide `b63736d5…` in the owner's Claude Docs.
  2026-10-05: idle alerts no longer need a recent event, only a connected location.
- **Next — pilot period (owner, 2026-10-02):** clients try the app free for a first period; feedback
  decides pricing and what comes next. Per-client onboarding checklist and the client guide live in the
  owner's Claude Docs (internal guide `ac3e1e8b…`, client guide `e5529e64…`). Per client: install 2.0.1, choose the company language,
  set timezone (`Europe/Istanbul` for Turkey; default is `Asia/Riyadh`), working hours/days, target,
  breaks; monitoring off unless asked, idle 30–45 min to start; employees informed.
- **Open before/at first clients:** test the Custom Page in the GHL mobile app (never tested); confirm
  daily DB backups on Hostinger; WhatsApp/SMS/calls not yet observed carrying `userId` (owner chose not to
  test — on WhatsApp-only clients keep monitoring off or check the first event). The second install is
  still on Marketplace 1.0.0 (update from that sub-account).
- **Deferred:** "end at last activity" (spec §11); non-message activity events; "note sent" state.
- **Tests:** unit 53, frontend 154, smoke 210/0 locally (foreign-appId check skipped), 134/0 in production mode.

## In Progress
- Nothing mid-flight. The frontend redesign (spec `docs/superpowers/specs/2026-09-19-frontend-redesign-design.md`,
  plan `docs/superpowers/plans/2026-09-19-frontend-redesign.md`) is fully implemented
  and merged to `main` through commit `1bf0ca2` (final review clean).

## Next Steps (prioritized)
1. **Set up the GHL Marketplace app** (Private, Sub-Account, Custom Page =
   `https://timeclock.noursky.com`). Generate the real Shared Secret and replace the
   placeholder `GHL_SHARED_SECRET` in Hostinger env, then redeploy/restart.
2. **Verify the real SSO payload** on a live GHL sub-account: print the decrypted
   payload and confirm field names (`userId`, `role`, `type`, `activeLocation`,
   `userName`, `email`) and the postMessage message names (`PROJECT.md` §17).
3. **Run the backend smoke test against the live DB** (expect 23/23):
   `BASE_URL=https://timeclock.noursky.com GHL_SHARED_SECRET=<real> npm run test:smoke`.
4. Optional QUIC/HTTP3 note: first load occasionally hits `ERR_QUIC_PROTOCOL_ERROR`
   from the CDN; a reload fixes it. Consider disabling HTTP3 on the CDN if it persists.
5. Future features (deferred by decision — see spec §9 / DECISIONS.md): dark mode,
   breaks/Pause, per-day week bars + weekly heatmap, requests/approvals, leave,
   employee deactivation, lateness from `work_start`, first-in/last-out column,
   native `<dialog>` for the edit modal (focus trap/ESC).

## Open Questions / Blockers
- **Attendance policies phase 1 (this branch) is verified locally but deliberately
  NOT deployed.** Deploying requires, in order: (1) run
  `ALTER TABLE settings ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 15 AFTER work_start;`
  against the production DB via hPanel → phpMyAdmin, (2) `git push origin main`,
  (3) verify `/health` and the manager report's new column live. This is a decision
  for the project owner, not something to do unprompted.
- Deferred items from phase 1, not to be lost:
  - ~~The 09:15:00 / 09:15:01 grace-boundary proof was run in a throwaway script, not
    committed to the smoke suite.~~ **Fixed** in the final review pass: committed to
    `scripts/smoke-test.mjs` on an `Asia/Dubai` fixture location (`work_start 09:00`,
    grace 15), with best-effort cleanup of its rows.
  - ~~`late_days` counts a boundary day whose only session lies entirely outside
    `[from, to)`, while `days_present` excludes it.~~ **Fixed** in the final review
    pass: an `EXISTS` subquery restricts the candidate days to days with at least one
    session overlapping `[from, to)`, while `MIN(started_at)` stays unrestricted.
  - `tzOffsetSec()` returns an offset 1 second too small when
    `Date.now() % 1000 >= 500`. It was neutralised **inside the report handler
    only**; the shared helper is untouched. It currently has exactly one call site,
    so nothing else is affected today — but the latent bug remains in the helper.
  - The smoke fixture has only one location, so a `location_id`-only leak is not
    independently proven.
- GHL SSO field/message names are assumed from docs and MUST be verified on a real
  sub-account before production login works (blocker for GHL go-live).
- Custom-range date filter can drift by one day at the boundary for non-UTC users
  (deferred; low impact on rolling report windows).
- `--warn` brand token is `#8A6508` (from the supplied design) vs `#B8860B` in older
  CLAUDE.md prose — the design value was adopted; reconcile docs if it matters.

## Session Log
_(append-only, newest on top: date · summary · files · commit)_

- **2026-10-07** · **Early-leave approval** on `feature/early-leave` (plan
  `docs/superpowers/plans/2026-10-07-early-leave-approval.md`, executed inline). Migration 007
  (`settings.early_leave_approval`, `sessions.closed_by` += `approved`, table `early_leave_requests`) —
  **NOT yet applied in production; apply in phpMyAdmin before merging/pushing.** Server: stop guard,
  employee request/cancel/list, manager list/approve/reject, lazy expiry, `early_leave` in `/me/status`.
  Web: request dialog, pending/rejected/approved banners, "طلباتي", manager panel (pending + history with
  search), settings checkbox, report label, ⚠️ title counter, `timeclock:refresh` after a decision.
  Verified: unit 57/0, smoke 244/0, frontend 184/0, build ok, local browser run of the whole flow
  (request → reject with note → request → approve; histories on both sides; session closed_by approved).
  Terra install fixed earlier the same day (installed; "مربوط"). Next: owner applies 007 → merge → deploy →
  turn the setting on for Terra (timezone Asia/Damascus, work end set).

- **2026-10-07** · **Terra install fails** ("GHL رفض طلب الربط"). Log: `[oauth] OAUTH_EXCHANGE_FAILED 200`
  twice (2026-10-06 10:42, 2026-10-07 09:31 UTC): GHL answered 200 but without `access_token`/`locationId`
  — most likely an agency-level (Company / bulk) token, which the exchange does not support. The log now
  adds the response shape (userType, bulk flag, error code, field names; never a token value) to confirm
  on the next attempt. Unit 54/0. · files: src/ghlOAuth.js (+test), src/server.js

- **2026-10-06** · **Live floor shows net time.** The manager's "الفريق الآن" timer counted the session's
  breaks (now − start) while the employee's timer subtracts them. `GET /admin/live` now returns
  `break_sec` per open session (same BREAK_SEC_EXPR as `/me/status`) and the floor shows now − start −
  break_sec. Verified: smoke 211/0, unit 53/0, frontend 166/0, local browser (both timers 0:00:09 after an
  8 s break). · files: src/server.js, LiveFloor (+test), smoke

- **2026-10-06** · **Faster clock-out.** The owner saw a few seconds' delay after "end shift": the screen
  waited for 4 requests in a row (stop, status, week, alerts; ~0.2 s round trip each from Turkey plus
  the server). The three reads now go out together (2 rounds). The server logs `[slow] METHOD /path
  Nms status` for any request ≥ 500 ms (nodejs/console.log on Hostinger) to trace any remaining delay.
  Verified: frontend 165/0, smoke 210/0, unit 53/0, local browser timing. · files: EmployeeScreen (+test),
  src/server.js

- **2026-10-06** · **Live refresh.** Verified on Innova that the idle alert now reaches the manager
  without any event (fix of 2026-10-05). The owner saw the employee's idle banner only after a reload:
  new `usePolling` hook (30 s + at once on tab return) on the employee screen, alerts and live floor;
  history reloads with each re-read and after actions; the report re-reads every minute (DECISIONS).
  Also corrected the guides: an Admin account cannot clock in (the employee/manager switch is
  dev/preview only). Verified: frontend 164/0, build ok, local browser run (poll every 30 s, banner
  without reload). · files: web/src/usePolling.js (+test), EmployeeScreen, MyHistory, AlertsPanel,
  LiveFloor, ReportPanel (+tests), CLAUDE.md, DECISIONS

- **2026-10-05** · **Idle alert without any event.** Owner tested on Innova (threshold 1 min) and got
  no alert: no event had reached the location since 2026-10-02, so the 24 h outage guard skipped it.
  The guard is now "connected" (installed + activity scope) for idle time, the idle alert and session
  summaries (DECISIONS). Also: the 2026-10-03 Hostinger deploy of b969af5 (docs only) failed with
  "Failed to clone the repository" — production stayed on 007924c; the next deploy (9e47002, this fix)
  completed fine on 2026-10-05 (deploy log checked, `activityConnected` in the running build).
  Client guide PDF and internal install guide PDF made (owner's files, not in the repo). Verified:
  smoke 210/0, unit 53/0, frontend 154/0. · files: src/server.js, scripts/smoke-test.mjs, spec, DECISIONS

- **2026-10-03** · **Arabic + English** on `feature/bilingual` (subagent-driven, plan
  `docs/superpowers/plans/2026-10-03-bilingual.md`). Migration 006 (`settings.locale`,
  `employees.locale`); login returns `user.locale`; `PUT /me/locale`; settings locale; bilingual
  install pages by `Accept-Language`; home-made i18n (provider, `t()`, `locales/ar.js` + `en.js`,
  guard tests incl. a source scan); English duration units; top-bar language button;
  direction-neutral CSS; employee and manager screens fully translated; company-language select;
  time pickers for work and break times (DECISIONS). Verified: unit 53/0, frontend 150/0, build ok,
  smoke 210/0 locally and 134/0 in production mode. Migration 006 pending in production; not
  pushed. · commits (oldest first): see `git log --oneline main..HEAD` (aefed36 backend + migration,
  7cda994 language module, 0b1296d direction/skip-link fixes, 950f88f employee screens,
  5d041e6 manager screens), plus the docs commit. Final review fixes: saving the company language
  switches the manager's own screen (no personal override), English wording polish, closed-by
  names translated, `effectiveLocale` tolerates a DB without migration 006 (frontend 154/0). · files: migrations/006, schema.sql,
  src/server.js, web/src/i18n.jsx, web/src/locales/**, web/**, CLAUDE.md, docs/**

- **2026-10-02** · Activity monitoring **phase C** (idle alert) on `feature/activity-monitoring-c`
  (subagent-driven). Idle alert to manager and employee after `idle_minutes` without activity;
  detector every 60 s, ends on activity/session end, late events resolve `late_activity` (DECISIONS).
  Verified: unit 53/0, frontend 135/0, build ok, smoke 189/0 locally and 122/0 in production mode.
  No migration; not pushed. · commits (oldest first): a4342f4 pure rules, 3e02d58 detect/end/late,
  77c28be manager UI + one-minute threshold, 2f91bcb employee banner + refresh + tab title, plus the
  docs commit. · files: src/server.js, src/activity.js, scripts/smoke-test.mjs, web/**, CLAUDE.md,
  PROJECT.md, docs/**

- **2026-10-02** · Activity monitoring **phase B** on `feature/activity-monitoring-b`
  (spec `docs/superpowers/specs/2026-09-29-activity-monitoring-design.md`, subagent-driven,
  9 tasks). One alert only: "working, not clocked in" inside working hours; idle is information,
  not an alert. Absent settings fields are kept on PUT (DECISIONS). Verified: unit 49/0,
  frontend 122/0, build ok, smoke 169/0 locally and 121/0 in production mode. Migration 005
  pending in production; not pushed. · commits (oldest first): 0d9d7f6 settings work_end/work_days,
  cb38f09 activity rules, 676f5c6 not-clocked-in alert, 870884c dismiss/note, dafa2c3 idle +
  summary + unknown users, afbafc1 summary failures never break a request + bounded scans,
  f9b6249 settings UI, 908c325 checkbox sizing/bit-mapping, fadd531 alerts panel + chips + session
  columns, f09bcd9 employee banner, 5a1f94f note errors/double-send guard, plus the docs commit.
  · files: migrations/005, schema.sql, src/server.js, src/activity.js, scripts/smoke-test.mjs,
  web/** , CLAUDE.md, docs/**

- **2026-10-02** · Activity monitoring went live on Innova. Routes renamed to
  `/webhooks/events` + `/oauth/callback` (GHL rejects URLs containing "ghl"). Marketplace
  draft configured and published as 2.0.0 (GHL forced major for the new scope); new default
  client key `timeclock-server`. Hostinger env: the first attempt was lost because "Add"
  only stages — **Apply changes** saves (see DECISIONS). Verified: callback 503 → 502 with a
  fake code once env loaded; Innova update stored the install; webhooks verified and stored.
  First real events matched to the GHL thread: automatic IG reply without `userId`, typed
  IG + Email with it → spec §2.1. · files: spec, DECISIONS.md, PROGRESS.md

- **2026-09-29** · Activity monitoring **phase A** on `feature/activity-monitoring-a`
  (spec `docs/superpowers/specs/2026-09-29-activity-monitoring-design.md`, plan
  `…-phase-a.md`, subagent-driven, 5 tasks + final review). Research first: GHL has **no
  public Audit Logs API** — owner approved official webhooks as *evidence and alerts only*,
  in-app only (no paid workflow triggers). Migration 004 (all phase A+B tables; alert
  uniqueness via numeric `*_open_flag` columns because MariaDB 11.8 rejects string STORED
  generated columns — verified end to end on MariaDB 11.8.9 and MySQL 8.0.46). Review
  fixes: streaming body limit, key checked before the one-time code is exchanged,
  production-aware smoke, and the discovery that GHL signs **every** app's webhooks with
  one key → `GHL_APP_ID` filter + `messageId` dedupe. Migration 004 applied 2026-09-30, merged
  to `main` and pushed.
- **2026-09-28** · "مجموع اليوم" on the employee screen is now the location's calendar
  day: `/me/status` defaults `since` to local midnight (`localDayBounds`), a session across
  midnight counts only its after-midnight part, and the response carries `day_ends_at` so
  an open screen reloads at midnight. Weekly total unchanged (rolling 7 days). Smoke 96,
  frontend 91, unit 15. Parked: the midnight reload doesn't retry if that one fetch fails.
- **2026-09-28** · **Break modes** on `feature/break-modes` (plan
  `docs/superpowers/plans/2026-09-27-break-modes.md`, spec §5.4b, subagent-driven, 5 tasks
  + final review). Migration 003 (`settings.break_mode/break_start/break_end/break_paid/
  break_policy_since`, `breaks.kind` + generated `fixed_key` + `ux_fixed_window`); tz
  helpers `localDate`/`wallToUtc`/`fixedWindows`/`localDayBounds`; unpaid fixed windows
  recorded by `autoCloseStale`, PUT and PATCH (newly covered windows only, in the txn);
  `/me/status` + `/admin/live` expose the window; settings UI; employee/live-floor pause.
  Review fixes: a same-day window change double-deducted pay (now one row per session per
  local day), PUT records begun windows before changing policy, policy applies from save,
  CSV Hours clamped. Unit 15, frontend 90, smoke 93. Migration 003 applied in production,
  merged to `main` and pushed.
- **2026-09-27** · Attendance policies **phase 2** on `feature/attendance-policies-phase2`
  (plan `docs/superpowers/plans/2026-09-27-attendance-policies-phase2.md`, subagent-driven,
  6 tasks + final review). Migration 002 (`breaks` table, `sessions.note`,
  `settings.breaks_enabled`, `settings.note_on_stop`); break start/stop endpoints with
  transaction + FOR UPDATE; worked-time SQL subtracts clipped breaks; `/session/stop`
  enforces the note policy; CSV adds Break (min) + Note with a formula guard; UI for
  employee, settings, manager detail, live floor, history. Final review fix wave: dialog
  shows stop errors and refreshes on NO_OPEN_SESSION, null-JSON-body hardening, break/stop
  locks session first, `(location_id, ended_at)` breaks index, PROJECT.md/CLAUDE.md
  updated. 80/80 frontend, 66/66 smoke, 8/8 unit. Migration 002 applied in production
  (phpMyAdmin) on 2026-09-27, then merged to `main` and pushed.
- **2026-09-27** · Closed the three phase-1 minors. (1) `tzOffsetSec` truncates to whole
  seconds itself (was 1s short with a millisecond Date); call-site workaround removed.
  (2) DST: report `late_days`/`days_present` and `/admin/sessions` `late_by_sec` now use
  each date's own offset via `localZone()` in new `src/tz.js` (SQL `CASE` per offset
  change in the window), plus a 2-day-padded `started_at` pre-filter so the index is
  used. Smoke fixture on Europe/Berlin (08:30 CET vs 09:30 CEST) failed on the old code
  (late_days 2) and passes now (1). (3) `migrations/` with `001_late_grace_minutes.sql`
  + README (applied log, deploy order). New `npm run test:unit` (node:test, 8 tests).
  8/8 unit, 56/56 frontend, 41/41 smoke. Decision recorded in DECISIONS.md.
- **2026-09-27** · (1) "سجلّي" rendered times with the device clock; `GET /me/sessions`
  now returns the location `timezone` and `MyHistory` formats with `formatStamp`
  (new `{ year: false }` compact form). The ReportPanel timezone test used
  Asia/Riyadh — identical to the UTC+3 dev machine, so it proved nothing; both
  timezone tests now use America/New_York. 56/56 frontend, 39/39 smoke · `893196e`,
  verified live. (2) Production DB cleanup, run by the user in phpMyAdmin after a
  read-only inventory: deleted only `location_id LIKE 'smoke-%' OR = 'dev-local'` —
  edits_log 1, sessions 5, employees 4, settings 2 (12 rows, exactly the inventory).
- **2026-09-27** · Manager can now audit lateness per session: `GET /admin/sessions`
  returns `late_by_sec` (non-null only for the local day's first session past
  `work_start + grace`, with the day's first resolved over the whole local day, not the
  requested window) plus `timezone`/`work_start`; ReportPanel drill-down gained a
  "التأخير" column and location-timezone timestamps (`formatLateness`/`formatStamp` in
  `web/src/time.js`). Files: `src/server.js`, `scripts/smoke-test.mjs`,
  `web/src/components/ReportPanel.jsx`, `web/src/time.js`, `web/src/styles.css`, tests.
  54/54 frontend, 38/38 smoke. Pushed + verified live · `2fab666`.
- **2026-09-26** · Fixed the four findings from the final whole-branch review of
  `feature/attendance-policies-phase1`: (1) `late_days` no longer counts local days
  with no session overlapping `[from, to)` — an `EXISTS` subquery narrows the candidate
  days while `MIN(started_at)` stays unrestricted, so the `d55f10a` behaviour is kept
  (reviewer's scenario: `late_days` 6 → 5 with `days_present` 5); (2) committed a real
  grace-boundary smoke case on a non-UTC location (`Asia/Dubai`, `work_start 09:00`,
  grace 15) asserting local 09:15:00 is on time and 09:15:01 is late, plus best-effort
  cleanup of its fixture rows — proven to fail against the pre-fix code path;
  (3) `PUT /admin/settings` now treats `undefined`/`null`/`""` grace as the 15-minute
  default server-side, while an explicit `0` is still honoured and 0–240 validation is
  intact; (4) the `/me/sessions` isolation check now requires `status === 200`.
  44/44 frontend tests, 35/35 smoke checks (was 31). Local only — no migration, no
  push, no deploy. · files: `src/server.js`, `scripts/smoke-test.mjs`,
  `docs/PROGRESS.md`, `.superpowers/sdd/2026-09-24-attendance-policies-phase1/final-fix-report.md`
  · commit: _(this fix pass)_
- **2026-09-24** · Attendance policies phase 1 (Tasks 1–5): `late_grace_minutes`
  setting (validated 0–240, `INVALID_GRACE`); `GET /me/settings` + employee daily
  target read from real `daily_target_hours` (settings fetch moved to its own
  mount-time effect so a settings failure can't block clock-in); `late_days` per
  employee in `GET /admin/report` (first-session-of-local-day vs. `work_start` +
  grace, computed via a per-day `MIN(started_at)` aggregate, not a correlated
  subquery) plus "أيام التأخير" column and grace-minutes field in the settings
  form; `GET /me/sessions?days=N` (1–31, `INVALID_DAYS`) scoped to the caller's own
  `uid`+`loc`, and a new `MyHistory` ("سجلّي — آخر 7 أيام") component under the
  employee clock-in screen. Verified end to end: 44/44 frontend Vitest tests,
  31/31 backend smoke-test checks, both against the local server/DB; production
  frontend build confirmed to contain the new Arabic strings. Migration + deploy
  to production **deliberately not done** — pending owner sign-off (see Open
  Questions / Blockers). · files: `src/server.js`, `schema.sql`,
  `scripts/smoke-test.mjs`, `web/src/components/EmployeeScreen.jsx`,
  `web/src/components/ReportPanel.jsx`, `web/src/components/SettingsPanel.jsx`,
  `web/src/components/MyHistory.jsx` (+ tests), `PROJECT.md`, `docs/PROGRESS.md`,
  `docs/DECISIONS.md` · commits: 8633452, a91c82e, 2f0565a, 835084e, d55f10a,
  59cd299, and this handoff.
- **2026-09-19** · Added shared project-context system (CLAUDE.md rewrite, PROGRESS.md,
  DECISIONS.md, `.claude/commands/handoff.md` + `resume.md`, `.claude/settings.json`
  SessionStart hook, `.gitignore` tidy). · files: CLAUDE.md, docs/PROGRESS.md,
  docs/DECISIONS.md, .claude/**, .gitignore · commit: _(this handoff)_
- **2026-09-19** · Frontend redesign complete (light theme, RTL): design system,
  Toast/Button, TopBar+App wiring, employee hero, KpiRow+LiveFloor, ReportPanel
  (custom range/search/CSV/edit), SettingsPanel, ManagerDashboard shell; LivePanel
  removed. 36/36 tests, build OK, final review clean. · files: web/src/** · commit: 1bf0ca2
- **2026-09-19** · Deployed to Hostinger (Node Web App, auto-deploy on push to main).
  Created DB + schema; fixed deploy (postinstall builds SPA; production-mode build so
  dev-login is hidden). `/health` green. · files: package.json, scripts/build-web.mjs,
  .gitignore · commits: 383907a and the deploy fixes before it.
- **2026-09-19** · Built the initial React frontend on the existing backend (employee
  + manager + settings + dev-login), served static from Hono. · files: web/**, src/server.js · commit: baseline → 0502a7d
