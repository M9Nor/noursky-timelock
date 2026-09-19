# CLAUDE.md — NourSky TimeClock

Read `PROJECT.md` first. It is the single source of truth for goals, architecture, API, rules, and roadmap.

## What this is
Employee clock-in/clock-out for GoHighLevel sub-accounts, shipped as a **Private GHL Marketplace App** (Custom Page + SSO). Backend runs on **Hostinger Cloud (managed Node.js)** with **MySQL/MariaDB**.

## Stack
- Node.js >= 20, ESM, plain JavaScript (no build step for the backend)
- Hono + `@hono/node-server`, `mysql2/promise` with `namedPlaceholders: true`
- Frontend (next task): React + Vite in `web/`, built into `public/`, served by Hono

## Hard rules
- `archive/cloudflare-worker/` is reference only. Do not edit or deploy it.
- SQL must run on **both MySQL 8 and MariaDB 10.2+**. Do not use: partial indexes, `UPDATE ... RETURNING`, `INSERT ... AS alias ON DUPLICATE KEY`. Use `VALUES(col)` in upserts and transactions + `SELECT ... FOR UPDATE` where you need read-then-write.
- All timestamps are UNIX seconds (UTC). Timezone conversion happens only for display/CSV.
- `location_id` and `user_id` always come from the verified token (`c.get("claims")`), never from the request body or query.
- Every `/admin/*` route uses `authed, managerOnly`.
- Never commit secrets. Config lives in env vars (see `.env.example`).
- Errors are returned as `{ error: "CODE" }` via `HttpError`. Add new codes to the table in `PROJECT.md` section 8.
- Any dev-only auth bypass must be gated by `NODE_ENV !== "production"`.

## UI rules (for `web/`)
- Arabic, RTL (`dir="rtl"`), numbers always Western digits (1, 2, 3).
- Brand colors: accent `#6C5CE7`, subheading `#E91E63`, text `#20203A`, muted `#5A5A72`, surfaces `#F4F0FF` / `#F7F7FB`, positive `#1E7F4F`, negative `#C0392B`, warning `#B8860B`.
- Keep the token in memory (React state), not localStorage. On 401, redo the SSO handshake once.
- Use `server_time` from the API for live timers, not the client clock.

## Commands
```bash
npm install
node --env-file=.env src/server.js          # local run
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=... npm run test:smoke
```
The smoke test must stay green (currently 20/20). Extend it when you add endpoints.

## Current status
- Done: backend, schema, SSO decryption, auto-close, smoke test.
- Next: `PROJECT.md` section 18 (React UI + static serving + build script).
