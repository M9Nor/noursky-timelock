# PROGRESS — NourSky TimeClock

Living handoff log. Read this + `DECISIONS.md` at the start of every session.

## Current State
_(overwrite each update)_
- **Branch:** `feature/attendance-policies-phase1` (not yet merged/pushed to `main`
  — see below) · **Last deploy:** live at `https://timeclock.noursky.com`
  (`/health` returns `{"ok":true}`, DB connected) is still on the pre-phase-1 code;
  the production DB has **not** received the `late_grace_minutes` migration yet.
- **Works:** Backend API (auth/SSO, sessions, admin report/live/sessions/settings,
  CSV export, auto-close). Redesigned React frontend (light theme, RTL): employee
  hero clock (Start/Stop, live server-time timer, today/week totals), manager
  dashboard (KPIs, live floor, report table with custom date range + search + CSV,
  session edit modal, settings). Auto-deploy on push to `main` (Hostinger Git).
  **Attendance policies phase 1 shipped on this branch** (not yet merged): a
  per-account `late_grace_minutes` setting (0–240, validated), lateness computed
  from `work_start` + grace and shown per employee as "أيام التأخير" in the manager
  report, the employee daily target read from the account's real
  `daily_target_hours` instead of a hardcoded 8h, and a new "سجلّي — آخر 7 أيام"
  panel showing the employee's own last-7-days session history. The final
  whole-branch review's four findings are fixed on top. 44/44 frontend Vitest tests
  pass; 35/35 backend smoke-test checks pass locally; production build succeeds.
- **Not done / broken:** GHL Marketplace app not yet created, so **real SSO login
  is not wired** — outside a GHL iframe the app shows the dev role-picker (dev build)
  or "session expired" (prod build). `GHL_SHARED_SECRET` on Hostinger is a temporary
  placeholder. Backend smoke test has been run locally only — **not yet run against
  the live DB**, and the phase-1 migration + deploy to production (`main`) is a
  deliberately separate, not-yet-authorised step (see Open Questions / Blockers).

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
