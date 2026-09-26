# DECISIONS — NourSky TimeClock

Append-only architectural/technical decision record. Newest on top.
Format: **Date — Decision** · Reason · Alternatives rejected.

---

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
