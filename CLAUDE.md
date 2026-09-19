# CLAUDE.md — NourSky TimeClock

> This repo is worked on from **multiple Claude Code accounts**. Chat history does
> NOT transfer between accounts, so all context lives in the repo. **Follow the
> Session Protocol at the bottom of this file every session.**

`PROJECT.md` is the deep single source of truth (goals, architecture, API, business
rules, roadmap). This file is the fast operational brief.

## Project overview
Employee clock-in/clock-out for GoHighLevel sub-accounts, shipped as a **Private GHL
Marketplace App** (Custom Page + SSO). A Node.js/Hono API serves a React SPA and a
MySQL/MariaDB database, deployed on **Hostinger Cloud (managed Node.js)** at
`https://timeclock.noursky.com`.

## Tech stack + versions
- **Node.js ≥ 20**, ESM, plain JavaScript (no TypeScript, no backend build step).
- **Backend:** Hono `^4.6` + `@hono/node-server` `^1.13`, `mysql2/promise` `^3.11`
  (with `namedPlaceholders: true`). Entry: `src/server.js`.
- **Frontend:** React 18 + Vite 5 in `web/`, built to `public/`, served static by Hono.
- **Frontend tests:** Vitest 2 + React Testing Library (jsdom). **Backend test:** a
  Node smoke test (`scripts/smoke-test.mjs`) that simulates GHL SSO.
- **DB:** MySQL 8 / MariaDB 10.2+ (`utf8mb4`).

## Folder structure
```
src/server.js            # entire backend API (Hono + mysql2): auth/SSO, sessions, admin, static serving
schema.sql               # DB schema (4 tables) — run once via phpMyAdmin import
scripts/smoke-test.mjs   # end-to-end backend smoke test (simulates GHL SSO)
scripts/build-web.mjs    # postinstall/build: installs web/ dev deps + vite build → public/
web/                     # React + Vite SPA (source of the UI)
  src/App.jsx            # auth (SSO/dev-login), 401-retry, role routing, TopBar + ToastProvider
  src/api.js             # fetch wrapper: bearer token, ApiError, api.download (authed CSV)
  src/auth.js            # GHL postMessage SSO handshake + dev-login
  src/time.js            # server-time offset + duration/clock formatting (Western digits)
  src/styles.css         # NourSky design system (light theme, class-based)
  src/components/        # Icon, Button, Toast, TopBar, EmployeeScreen, KpiRow, LiveFloor,
                         #   ReportPanel, SessionEditModal, SettingsPanel, ManagerDashboard
public/                  # Vite build output (gitignored; produced at deploy)
docs/                    # PROGRESS.md, DECISIONS.md, specs/, plans/, design-reference.html
archive/cloudflare-worker/  # reference only — never edit or deploy
.claude/                 # commands/ (handoff, resume) + settings.json (shared) ; settings.local.json is local-only
```

## Commands
```bash
# Install (also builds the frontend via postinstall)
npm install

# Local backend run (reads .env). Needs a local MySQL/MariaDB + schema imported.
node --env-file=.env src/server.js

# Frontend dev server (proxies API to :3000)
cd web && npm run dev

# Build frontend into public/
npm run build

# Frontend unit tests (no DB needed — API is mocked)
cd web && npx vitest run

# Backend smoke test (needs a running server + DB)
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=<same-as-.env> npm run test:smoke

# Lint: none configured yet (no eslint/prettier in the repo).
```

## Environment variables (NAMES ONLY — never commit values; see `.env.example`)
`NODE_ENV`, `PORT`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
`GHL_SHARED_SECRET`, `SESSION_SECRET`, `ALLOWED_ORIGIN` (optional).
- `NODE_ENV=production` is **required in prod** — it disables `/auth/dev-login`.
- On Hostinger these are set in the Node app's **Environment variables** panel, not in a file.

## Deployment flow: GitHub → Hostinger
- **Mechanism:** Hostinger hPanel → the site's **Web App (Node)** is connected to the
  GitHub repo `M9Nor/noursky-timelock` with **auto-deploy on push to `main`**.
- On each push to `main`, Hostinger pulls, runs `npm install` (which runs the
  `postinstall` → `scripts/build-web.mjs` → builds the SPA into `public/`), then starts
  the app with `npm start` (entry `src/server.js`). Node version 20.x.
- `public/` is gitignored and produced at deploy time — do NOT commit it.
- DB lives on the same Hostinger account (MySQL). Schema is imported once via phpMyAdmin.
- Health check after deploy: `GET https://timeclock.noursky.com/health` → `{"ok":true}`.
- **Context-only commits** (docs/**, CLAUDE.md) should not trigger a rebuild — a
  `paths-ignore` note is in DECISIONS.md; Hostinger's Git deploy does not currently
  support paths-ignore in the UI, so keep context commits small (they rebuild harmlessly).

## Code conventions (observed)
- Plain ESM JS everywhere; 2-space indent; no semicolon-free style (semicolons used).
- Errors: `{ error: "CODE" }` via `HttpError`; new codes go in `PROJECT.md` §8.
- All timestamps are UNIX seconds (UTC); timezone conversion only for display/CSV.
- Frontend: Arabic RTL, Western digits, class-based CSS tokens, token kept in memory
  (never localStorage), live timers from API `server_time`.

## Hard rules
- `archive/cloudflare-worker/` is reference only. Do not edit or deploy it.
- SQL must run on **both MySQL 8 and MariaDB 10.2+**. Do not use: partial indexes,
  `UPDATE ... RETURNING`, `INSERT ... AS alias ON DUPLICATE KEY`. Use `VALUES(col)` in
  upserts and transactions + `SELECT ... FOR UPDATE` for read-then-write.
- `location_id` and `user_id` always come from the verified token (`c.get("claims")`),
  never from the request body or query.
- Every `/admin/*` route uses `authed, managerOnly`.
- Any dev-only auth bypass must be gated by `NODE_ENV !== "production"`.
- **Never commit secrets, `.env` files, credentials, or Hostinger login data.**

## UI rules (for `web/`)
- Arabic, RTL (`dir="rtl"`), numbers always Western digits (1, 2, 3).
- Design system: light theme only (dark mode is deferred — see DECISIONS.md). Brand
  tokens live in `web/src/styles.css` `:root` (accent `#6C5CE7`, pink `#E91E63`, etc.).
- Keep the token in memory (React state/ref), not localStorage. On 401, redo the SSO
  handshake once. Use `server_time` for live timers, not the client clock.

---

## Session Protocol (MANDATORY — every session, every account)
1. **At session start:** run `git pull`, then read `docs/PROGRESS.md` and
   `docs/DECISIONS.md` before doing any work. (Or run `/resume`.)
2. **After every completed task or meaningful milestone** (not only at the end):
   update `docs/PROGRESS.md`.
3. **When an architectural or technical decision is made:** append it to
   `docs/DECISIONS.md` with date, decision, reason, and alternatives rejected.
4. **Before ending a session:** run `/handoff`.
5. **Never** commit secrets, `.env` files, credentials, or Hostinger login data.
