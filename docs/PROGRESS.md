# PROGRESS — NourSky TimeClock

Living handoff log. Read this + `DECISIONS.md` at the start of every session.

## Current State
_(overwrite each update)_
- **Branch:** `main` · **Last deploy:** `2fab666` live at `https://timeclock.noursky.com`
  (bundle `index-C6aTDy2o.js`, `/health` ok). The `late_grace_minutes` migration has
  been applied to the production DB.
- **Works:** Backend API (auth/SSO via the private GHL Marketplace app, sessions,
  admin report/live/sessions/settings, CSV export, auto-close). React frontend (light
  theme, RTL): employee hero clock + "سجلّي — آخر 7 أيام" history with the account's
  real daily target; manager dashboard (KPIs, live floor, report with custom range +
  search + CSV, session edit modal, settings). **Attendance policies phase 1 is live:**
  per-account `late_grace_minutes` (0–240), "أيام التأخير" per employee, and — new —
  a "التأخير" column in the employee session drill-down (`متأخر 5 س 37 د`) driven by
  `late_by_sec` from `GET /admin/sessions`; drill-down times now render in the
  location timezone. Verified live inside GHL (Innova): the 3 late days match the
  count. 54/54 frontend tests, 38/38 smoke checks locally.
- **Not done / known minors:** none open from phase 1. Local-day math is DST-safe
  (`src/tz.js`), `tzOffsetSec` is exact, and schema upgrades now live in `migrations/`.
  "سجلّي" renders in the company timezone and production test rows were removed.

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
