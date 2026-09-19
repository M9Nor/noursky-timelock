# PROGRESS — NourSky TimeClock

Living handoff log. Read this + `DECISIONS.md` at the start of every session.

## Current State
_(overwrite each update)_
- **Branch:** `main` · **Last deploy:** live at `https://timeclock.noursky.com`
  (`/health` returns `{"ok":true}`, DB connected).
- **Works:** Backend API (auth/SSO, sessions, admin report/live/sessions/settings,
  CSV export, auto-close). Redesigned React frontend (light theme, RTL): employee
  hero clock (Start/Stop, live server-time timer, today/week totals), manager
  dashboard (KPIs, live floor, report table with custom date range + search + CSV,
  session edit modal, settings). 36/36 frontend Vitest tests pass; production build
  succeeds. Auto-deploy on push to `main` (Hostinger Git).
- **Not done / broken:** GHL Marketplace app not yet created, so **real SSO login
  is not wired** — outside a GHL iframe the app shows the dev role-picker (dev build)
  or "session expired" (prod build). `GHL_SHARED_SECRET` on Hostinger is a temporary
  placeholder. Backend smoke test has NOT been run against the live DB yet.

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
- GHL SSO field/message names are assumed from docs and MUST be verified on a real
  sub-account before production login works (blocker for GHL go-live).
- Custom-range date filter can drift by one day at the boundary for non-UTC users
  (deferred; low impact on rolling report windows).
- `--warn` brand token is `#8A6508` (from the supplied design) vs `#B8860B` in older
  CLAUDE.md prose — the design value was adopted; reconcile docs if it matters.

## Session Log
_(append-only, newest on top: date · summary · files · commit)_

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
