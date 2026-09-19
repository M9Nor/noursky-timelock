# NourSky TimeClock — React Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Arabic RTL React frontend (employee screen + manager dashboard + settings) inside `web/`, serve its build as static files from the existing Hono API, and add a dev-only auth bypass so the UI can be developed without GHL.

**Architecture:** A single Vite + React SPA lives in `web/` and builds to `../public`. The existing Hono server (`src/server.js`) gains a dev-only `/auth/dev-login` endpoint (gated by `NODE_ENV !== "production"`) and a `serveStatic` mount for `public/` registered *after* all API routes with an SPA fallback to `index.html`. The SPA talks to the same origin (no CORS). Auth token lives in React state only (never localStorage). All timers derive from the API's `server_time`, never the client clock. Role gating is already enforced server-side by `managerOnly`; the UI mirrors it by showing the dashboard tab only when `role === "manager"`.

**Tech Stack:** React 18, Vite 5, plain CSS with CSS custom properties (no UI framework, no Tailwind), the existing Hono + `@hono/node-server` + `mysql2` backend. No TypeScript (matches the plain-JS backend). Testing: Vitest + React Testing Library for the frontend; the existing `scripts/smoke-test.mjs` for the backend, extended for the new endpoint.

**Spec:** `PROJECT.md` (single source of truth) — sections 10 (Frontend Spec), 11 (file structure), 18 (next task). Also `CLAUDE.md` (hard rules + UI rules).

## Global Constraints

Copied verbatim from `PROJECT.md` / `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Node.js >= 20, ESM, plain JavaScript.** No build step for the backend. The frontend uses Vite but the backend stays no-build.
- **Arabic, RTL** (`dir="rtl"` on `<html>`). Numbers always **Western digits** (1, 2, 3) — never Arabic-Indic (١، ٢، ٣). Force with `font-variant-numeric` / explicit `toLocaleString("en-US")` and `Intl` locale `"en"`/`"en-GB"` where numbers/dates render.
- **Brand colors (CSS variables):** accent `#6C5CE7`, subheading `#E91E63`, text `#20203A`, muted `#5A5A72`, surfaces `#F4F0FF` / `#F7F7FB`, positive `#1E7F4F`, negative `#C0392B`, warning `#B8860B`.
- **Token in memory (React state), not localStorage.** On `401`, redo the SSO handshake once, then fail to an error screen.
- **Use `server_time` from the API for live timers**, not the client clock. Compute a one-time offset `offset = server_time - Date.now()/1000` and derive displayed time from `Date.now()/1000 + offset`.
- **`location_id` and `user_id` always come from the verified token** (`c.get("claims")`), never from request body/query. The dev-login endpoint still mints a real signed token; it never lets the client choose `location_id`/`user_id` beyond a fixed dev fixture.
- **Any dev-only auth bypass MUST be gated by `NODE_ENV !== "production"`.** In production the endpoint must not exist / must 404.
- **Errors are `{ error: "CODE" }` via `HttpError`.** Any new error code must be added to the table in `PROJECT.md` section 8.
- **`archive/cloudflare-worker/` is reference only.** Never edit it.
- **API routes register BEFORE static serving.** The SPA fallback must never shadow an API route.
- **Keep the SPA lightweight** (runs inside a GHL iframe). No heavy dependencies.
- **The smoke test must stay green** (currently 20/20) and be extended when endpoints are added.

---

## File Structure

New / modified files and their single responsibility:

**Backend (modify):**
- `src/server.js` — add `/auth/dev-login` (dev-gated), add `serveStatic` mount + SPA fallback after API routes. Also factor the SSO→token→upsert logic so dev-login reuses it (DRY).
- `package.json` — add `build` script and `dev` convenience script; add `serve-static` usage (already in `@hono/node-server`).
- `.env.example` — document `NODE_ENV`.
- `scripts/smoke-test.mjs` — add a case asserting dev-login is disabled when the server runs in production mode (documented as manual, since the smoke test hits a running server whose NODE_ENV it can't change).
- `PROJECT.md` — add `DEV_LOGIN_DISABLED` error code to section 8; flip section 18 checkboxes as tasks land.

**Frontend (create):** all under `web/`
- `web/package.json` — Vite + React + Vitest deps, `build` → `../public`.
- `web/vite.config.js` — React plugin, `build.outDir = "../public"`, `server.proxy` for `/auth`,`/me`,`/session`,`/admin`,`/health` → `http://localhost:3000` during dev.
- `web/index.html` — `<html dir="rtl" lang="ar">`, root div.
- `web/src/main.jsx` — React root mount.
- `web/src/styles.css` — CSS variables (brand tokens), base RTL layout, shared component classes.
- `web/src/api.js` — fetch wrapper: base URL, `Authorization` header, JSON parse, throws typed `ApiError` carrying `{ status, code }`.
- `web/src/auth.js` — SSO handshake (`getGhlSso` via postMessage) + dev-login fallback; returns `{ token, user }`.
- `web/src/time.js` — server-time offset helpers + duration formatting (Western digits).
- `web/src/App.jsx` — top-level: runs auth on mount, holds token/user in state, routes to Employee vs Manager view, handles global 401-retry-once + error screen.
- `web/src/components/Button.jsx` — shared button with loading/disabled state.
- `web/src/components/EmployeeScreen.jsx` — big Start/Stop button, live timer, today + week totals.
- `web/src/components/ManagerDashboard.jsx` — tab shell (Live / Report / Settings) for managers.
- `web/src/components/LivePanel.jsx` — "who's working now", 30s refresh.
- `web/src/components/ReportPanel.jsx` — period filter + per-employee table + CSV export + employee session detail/edit modal.
- `web/src/components/SettingsPanel.jsx` — timezone / daily target / max session / work start form.
- `web/src/components/SessionEditModal.jsx` — edit a session (start/end/reason).
- Test files colocated: `web/src/*.test.js(x)` next to each unit.

---

## Task 0: Backend — dev-login endpoint + factored SSO logic

Adds a dev-only login so the SPA can be built and tested without GHL, and refactors the shared "issue token for a user" logic so both `/auth/sso` and `/auth/dev-login` use it (DRY). This must land first because every frontend task needs a way to obtain a token locally.

**Files:**
- Modify: `src/server.js` (SSO route ~189-212, add helper + new route)
- Modify: `PROJECT.md` (section 8 error table — add `DEV_LOGIN_DISABLED`)
- Modify: `.env.example` (document `NODE_ENV`)
- Modify: `scripts/smoke-test.mjs` (add dev-login smoke assertions)
- Test: manual + smoke (`scripts/smoke-test.mjs`)

**Interfaces:**
- Consumes: existing `signToken(claims)`, `q(sql, params)`, `now()`, `SESSION_TTL`, `env`.
- Produces:
  - `async function issueSession({ userId, loc, role, name, email })` → `{ token, user }` where `user = { uid, loc, role, name, email }`. Used by both auth routes.
  - `POST /auth/dev-login` body `{ role?: "manager"|"employee" }` → `200 { token, user }` when `NODE_ENV !== "production"`, else `404 { error: "DEV_LOGIN_DISABLED" }`. Fixed dev fixture: `loc = "dev-local"`, `userId = "dev-manager"|"dev-employee"`, `name = "مدير تجريبي"|"موظف تجريبي"`, `email = "dev@local"`.

- [ ] **Step 1: Write the failing smoke assertions**

Add to the end of `scripts/smoke-test.mjs`, before the final summary (`console.log(\`\n${passed}...`)`):

```js
// --- dev-login (only meaningful when the target server runs with NODE_ENV != production) ---
const dev = await fetch(`${BASE}/auth/dev-login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ role: "manager" }),
});
if (dev.status === 404) {
  check("dev-login disabled (server in production mode)", true);
} else {
  const devBody = await dev.json();
  check("dev-login returns a manager token", dev.status === 200 && devBody?.user?.role === "manager");
  const devEmp = await fetch(`${BASE}/auth/dev-login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "employee" }),
  }).then((r) => r.json());
  check("dev-login employee role", devEmp?.user?.role === "employee");
  const meDev = await call(devBody.token, "GET", "/me/status");
  check("dev-login token works on protected route", meDev.status === 200);
}
```

- [ ] **Step 2: Run smoke test to verify the new assertions fail**

Requires a local DB + running server. Run:

```bash
node --env-file=.env src/server.js &   # separate terminal
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=<same-as-.env> npm run test:smoke
```

Expected: the three new dev-login assertions FAIL (route returns 404 → but with `{error:"..."}` other than expected, or the route is genuinely missing → `dev.status === 404` branch passes trivially only if server truly lacks the route). Concretely: before implementation the route does not exist, Hono returns 404, so the "disabled" branch passes — which is a false pass. To force a real failing state, temporarily run the smoke server with `NODE_ENV` unset (dev). Then the 404 branch is wrong and the test meaningfully fails: **confirm you see `FAIL dev-login returns a manager token`.**

- [ ] **Step 3: Add the `issueSession` helper and refactor `/auth/sso`**

In `src/server.js`, add above the `/* ---------- Auth ---------- */` block:

```js
/** Upsert the employee, ensure a settings row, and mint our HMAC token. */
async function issueSession({ userId, loc, role, name, email }) {
  const t = now();
  await q(
    `INSERT INTO employees (user_id, location_id, name, email, role, created_at, updated_at)
     VALUES (:uid, :loc, :name, :email, :role, :t, :t)
     ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email),
                             role = VALUES(role), updated_at = VALUES(updated_at)`,
    { uid: userId, loc, name: name ?? null, email: email ?? null, role, t }
  );
  await q("INSERT IGNORE INTO settings (location_id, updated_at) VALUES (:loc, :t)", { loc, t });
  const claims = { uid: userId, loc, role, name: name ?? "", email: email ?? "", exp: t + SESSION_TTL };
  const { exp, ...user } = claims;
  return { token: signToken(claims), user };
}
```

Then replace the body of `/auth/sso` (lines ~189-212) so it reuses the helper:

```js
app.post("/auth/sso", async (c) => {
  const { encryptedData } = await c.req.json().catch(() => ({}));
  if (!encryptedData) throw new HttpError(400, "MISSING_ENCRYPTED_DATA");

  const d = decryptSSO(encryptedData, env.GHL_SHARED_SECRET);
  const loc = d.activeLocation;
  if (!loc) throw new HttpError(403, "OPEN_FROM_SUB_ACCOUNT");

  const role = d.role === "admin" || d.type === "agency" ? "manager" : "employee";
  return c.json(await issueSession({
    userId: d.userId, loc, role, name: d.userName ?? "", email: d.email ?? "",
  }));
});
```

- [ ] **Step 4: Add the dev-login route (gated)**

Immediately after the `/auth/sso` route:

```js
app.post("/auth/dev-login", async (c) => {
  if (env.NODE_ENV === "production") throw new HttpError(404, "DEV_LOGIN_DISABLED");
  const { role } = await c.req.json().catch(() => ({}));
  const isMgr = role === "manager";
  return c.json(await issueSession({
    userId: isMgr ? "dev-manager" : "dev-employee",
    loc: "dev-local",
    role: isMgr ? "manager" : "employee",
    name: isMgr ? "مدير تجريبي" : "موظف تجريبي",
    email: "dev@local",
  }));
});
```

- [ ] **Step 5: Document the error code and env var**

In `PROJECT.md` section 8 error table, add a row (keep alphabetical/logical grouping near auth codes):

```
| `DEV_LOGIN_DISABLED` | 404 | dev-login مطلوب بالإنتاج | (تطوير فقط) |
```

In `.env.example`, add after `PORT=3000`:

```
# development | production — dev-login is disabled when this is "production"
NODE_ENV=development
```

- [ ] **Step 6: Run smoke test to verify pass (dev mode)**

Run the server WITHOUT `NODE_ENV=production` (dev), then:

```bash
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=<same-as-.env> npm run test:smoke
```

Expected: all previous 20 assertions PASS, plus `dev-login returns a manager token`, `dev-login employee role`, `dev-login token works on protected route` PASS. Then restart the server with `NODE_ENV=production` and re-run: expected `dev-login disabled (server in production mode)` PASS. **Report both runs' output.**

- [ ] **Step 7: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md .env.example
git commit -m "feat(backend): add dev-only /auth/dev-login and factor issueSession"
```

---

## Task 1: Vite + React scaffold and static serving from Hono

Stands up an empty-but-real SPA that builds to `public/` and is served by the existing Hono server, with the dev proxy wired so the SPA can call the API on port 3000 during development. Deliverable: `npm run build` produces `public/index.html`, and hitting the Hono server at `/` returns that page while `/health` still returns JSON.

**Files:**
- Create: `web/package.json`, `web/vite.config.js`, `web/index.html`, `web/src/main.jsx`, `web/src/App.jsx` (placeholder), `web/src/styles.css`
- Modify: `src/server.js` (add `serveStatic` after API routes)
- Modify: `package.json` (root — add `build`)
- Modify: `.gitignore` (ignore `web/node_modules`, `public/`)
- Test: manual (build + curl)

**Interfaces:**
- Consumes: `/auth/dev-login`, `/health` (from Task 0 / existing).
- Produces: `web/` buildable SPA; root `npm run build` → `public/`; Hono serves `public/` with SPA fallback. `App.jsx` here is a placeholder replaced in Task 5.

- [ ] **Step 1: Write `web/package.json`**

```json
{
  "name": "noursky-timeclock-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^16.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `web/vite.config.js`**

```js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://localhost:3000";
const apiPaths = ["/auth", "/me", "/session", "/admin", "/health"];

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../public", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(apiPaths.map((p) => [p, { target: API, changeOrigin: true }])),
  },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/test-setup.js" },
});
```

- [ ] **Step 3: Write `web/index.html`, `web/src/test-setup.js`, `web/src/main.jsx`, placeholder `web/src/App.jsx`, and `web/src/styles.css`**

`web/index.html`:

```html
<!doctype html>
<html dir="rtl" lang="ar">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>الدوام</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

`web/src/test-setup.js`:

```js
import "@testing-library/jest-dom";
```

`web/src/main.jsx`:

```jsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);
```

`web/src/App.jsx` (placeholder, replaced in Task 5):

```jsx
export default function App() {
  return <div className="card">TimeClock</div>;
}
```

`web/src/styles.css` (brand tokens + RTL base; Western digits enforced globally):

```css
:root {
  --accent: #6C5CE7;
  --subheading: #E91E63;
  --text: #20203A;
  --muted: #5A5A72;
  --surface: #F4F0FF;
  --surface-2: #F7F7FB;
  --positive: #1E7F4F;
  --negative: #C0392B;
  --warning: #B8860B;
  --radius: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: system-ui, "Segoe UI", Tahoma, Arial, sans-serif;
  color: var(--text);
  background: var(--surface-2);
  direction: rtl;
  /* Western digits everywhere, even inside Arabic text runs */
  font-variant-numeric: lining-nums;
}
.card {
  background: #fff;
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: 0 1px 4px rgba(32,32,58,.08);
}
.btn {
  border: 0; border-radius: var(--radius); padding: 14px 22px;
  font-size: 1rem; font-weight: 600; cursor: pointer; color: #fff;
  background: var(--accent);
}
.btn:disabled { opacity: .6; cursor: default; }
.btn-stop { background: var(--negative); }
.muted { color: var(--muted); }
.error { color: var(--negative); }
```

- [ ] **Step 4: Add static serving to `src/server.js` (AFTER all API routes)**

Add this import near the top with the other imports:

```js
import { serveStatic } from "@hono/node-server/serve-static";
```

Add immediately BEFORE the `/* Boot */` section (i.e. after `PUT /admin/settings` and after `app.onError`, but the mount must be the last route registration):

```js
/* ---------- Static SPA (must be registered AFTER all API routes) ---------- */
app.use("/*", serveStatic({ root: "./public" }));
app.get("/*", serveStatic({ path: "./public/index.html" })); // SPA fallback
```

- [ ] **Step 5: Add root `build` script and update `.gitignore`**

In root `package.json` scripts, add:

```json
"build": "cd web && npm install && npm run build"
```

In `.gitignore`, add (create the file if missing):

```
node_modules/
web/node_modules/
public/
.env
```

- [ ] **Step 6: Build and verify static serving**

```bash
cd web && npm install && npm run build && cd ..
ls public/index.html                      # exists
node --env-file=.env src/server.js &       # dev server
curl -s localhost:3000/health              # → {"ok":true,...}  (API still wins)
curl -s localhost:3000/ | grep -q 'id="root"' && echo "SPA served"
curl -s localhost:3000/some/spa/route | grep -q 'id="root"' && echo "SPA fallback works"
```

Expected: `/health` returns JSON, `/` and unknown routes return the SPA HTML. **Report the output.**

- [ ] **Step 7: Commit**

```bash
git add web package.json .gitignore src/server.js
git commit -m "feat(web): scaffold Vite+React SPA and serve build static from Hono"
```

---

## Task 2: API client, auth module, and time helpers

Pure logic units the UI depends on: a fetch wrapper that attaches the bearer token and throws typed errors, an auth module that does the GHL postMessage handshake with a dev-login fallback, and time helpers that convert durations to `HH:MM:SS` using Western digits and a server-time offset. These are unit-tested in isolation.

**Files:**
- Create: `web/src/api.js`, `web/src/auth.js`, `web/src/time.js`
- Test: `web/src/api.test.js`, `web/src/auth.test.js`, `web/src/time.test.js`

**Interfaces:**
- Produces:
  - `web/src/api.js`: `class ApiError extends Error { status; code; }`; `createApi(getToken)` → `{ get(path), post(path, body), put(path, body), patch(path, body), rawUrl(path) }`. Each method returns parsed JSON or throws `ApiError`. `getToken` is a function returning the current token string (or null).
  - `web/src/time.js`: `serverOffset(serverTime)` → number (seconds, `serverTime - Date.now()/1000`); `nowWithOffset(offset)` → seconds; `formatDuration(sec)` → `"H:MM:SS"` Western digits; `formatHours(sec)` → `"8.50"` (2 dp, Western).
  - `web/src/auth.js`: `getGhlSso()` → Promise resolving to encrypted string (rejects `SSO_TIMEOUT` after 5s); `login(api, { devRole })` → `{ token, user }`. In a GHL iframe it does the handshake → `POST /auth/sso`; the caller decides when to use dev-login. Export `devLogin(role)` → `{ token, user }` calling `POST /auth/dev-login`.

- [ ] **Step 1: Write failing tests for `time.js`**

`web/src/time.test.js`:

```js
import { describe, it, expect } from "vitest";
import { formatDuration, formatHours, serverOffset } from "./time.js";

describe("time helpers", () => {
  it("formats duration as H:MM:SS with Western digits", () => {
    expect(formatDuration(0)).toBe("0:00:00");
    expect(formatDuration(65)).toBe("0:01:05");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(36000)).toBe("10:00:00");
  });
  it("clamps negative durations to zero", () => {
    expect(formatDuration(-5)).toBe("0:00:00");
  });
  it("formats hours to two decimals", () => {
    expect(formatHours(3600)).toBe("1.00");
    expect(formatHours(1800)).toBe("0.50");
  });
  it("serverOffset returns seconds difference", () => {
    const off = serverOffset(Math.floor(Date.now() / 1000) + 100);
    expect(off).toBeGreaterThan(90);
    expect(off).toBeLessThan(110);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/time.test.js`
Expected: FAIL — `Failed to resolve import "./time.js"`.

- [ ] **Step 3: Implement `web/src/time.js`**

```js
export function serverOffset(serverTime) {
  return serverTime - Date.now() / 1000;
}
export function nowWithOffset(offset) {
  return Date.now() / 1000 + offset;
}
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(ss)}`;
}
export function formatHours(sec) {
  return (Math.max(0, sec) / 3600).toFixed(2);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/time.test.js`
Expected: PASS (all 4).

- [ ] **Step 5: Write failing tests for `api.js`**

`web/src/api.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApi, ApiError } from "./api.js";

describe("api client", () => {
  beforeEach(() => { global.fetch = vi.fn(); });

  it("attaches bearer token and parses JSON", async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ x: 1 }) });
    const api = createApi(() => "TOK");
    const r = await api.get("/me/status");
    expect(r).toEqual({ x: 1 });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer TOK");
  });

  it("throws ApiError with code on non-ok", async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "SESSION_ALREADY_OPEN" }) });
    const api = createApi(() => "TOK");
    await expect(api.post("/session/start")).rejects.toMatchObject({ status: 409, code: "SESSION_ALREADY_OPEN" });
  });

  it("omits Authorization when no token", async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const api = createApi(() => null);
    await api.post("/auth/dev-login", { role: "manager" });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `cd web && npx vitest run src/api.test.js`
Expected: FAIL — cannot resolve `./api.js`.

- [ ] **Step 7: Implement `web/src/api.js`**

```js
export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function createApi(getToken) {
  async function request(method, path, body) {
    const token = getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? "INTERNAL_ERROR");
    return data;
  }
  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    rawUrl: (p) => p, // same-origin; used for CSV download links
  };
}
```

- [ ] **Step 8: Run to verify pass**

Run: `cd web && npx vitest run src/api.test.js`
Expected: PASS (all 3).

- [ ] **Step 9: Write failing test for `auth.js`**

`web/src/auth.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { devLogin, getGhlSso } from "./auth.js";

describe("auth", () => {
  it("devLogin posts role and returns token+user", async () => {
    const api = { post: vi.fn().mockResolvedValue({ token: "T", user: { role: "manager" } }) };
    const r = await devLogin(api, "manager");
    expect(api.post).toHaveBeenCalledWith("/auth/dev-login", { role: "manager" });
    expect(r).toEqual({ token: "T", user: { role: "manager" } });
  });

  it("getGhlSso rejects on timeout", async () => {
    vi.useFakeTimers();
    const p = getGhlSso(10);
    vi.advanceTimersByTime(11);
    await expect(p).rejects.toThrow("SSO_TIMEOUT");
    vi.useRealTimers();
  });

  it("getGhlSso resolves with payload from postMessage", async () => {
    const p = getGhlSso(5000);
    window.dispatchEvent(new MessageEvent("message", {
      data: { message: "REQUEST_USER_DATA_RESPONSE", payload: "ENC" },
    }));
    await expect(p).resolves.toBe("ENC");
  });
});
```

- [ ] **Step 10: Run to verify fail**

Run: `cd web && npx vitest run src/auth.test.js`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 11: Implement `web/src/auth.js`**

```js
// Mirrors PROJECT.md §10 SSO handshake. Field/message names must be verified
// against a real GHL sub-account (PROJECT.md §17) before production.
export function getGhlSso(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("SSO_TIMEOUT"));
    }, timeoutMs);
    function handler({ data }) {
      if (data?.message === "REQUEST_USER_DATA_RESPONSE") {
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(data.payload);
      }
    }
    window.addEventListener("message", handler);
    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
  });
}

export async function ssoLogin(api) {
  const encryptedData = await getGhlSso();
  return api.post("/auth/sso", { encryptedData }); // { token, user }
}

export async function devLogin(api, role) {
  return api.post("/auth/dev-login", { role }); // { token, user }
}
```

- [ ] **Step 12: Run to verify pass**

Run: `cd web && npx vitest run src/auth.test.js`
Expected: PASS (all 3).

- [ ] **Step 13: Commit**

```bash
git add web/src/api.js web/src/api.test.js web/src/auth.js web/src/auth.test.js web/src/time.js web/src/time.test.js
git commit -m "feat(web): api client, auth handshake+dev-login, time helpers with tests"
```

---

## Task 3: Shared Button + Employee screen

The employee-facing screen: one big Start/Stop button (with loading state to prevent double-clicks), a live counter driven by `server_time`, and today/week totals. This is the whole experience for a non-manager user.

**Files:**
- Create: `web/src/components/Button.jsx`, `web/src/components/EmployeeScreen.jsx`
- Test: `web/src/components/EmployeeScreen.test.jsx`

**Interfaces:**
- Consumes: `createApi` result (`api`), `formatDuration`, `formatHours`, `serverOffset`, `nowWithOffset`. Backend routes `GET /me/status` (`{ open_session:{id,started_at}|null, worked_sec, server_time }`), `POST /session/start` (201), `POST /session/stop` (200).
- Produces:
  - `Button({ onClick, loading, disabled, variant, children })` — `variant` `"start"|"stop"`; shows a spinner/label swap while `loading`, disables during it.
  - `EmployeeScreen({ api })` — self-contained; fetches status on mount, renders button + live timer + totals, handles start/stop with optimistic loading and error text.

- [ ] **Step 1: Write the failing test**

`web/src/components/EmployeeScreen.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EmployeeScreen from "./EmployeeScreen.jsx";

function makeApi(statusSeq) {
  let i = 0;
  return {
    get: vi.fn(async () => statusSeq[Math.min(i++, statusSeq.length - 1)]),
    post: vi.fn(async () => ({})),
  };
}

describe("EmployeeScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows start button when no open session", async () => {
    const api = makeApi([{ open_session: null, worked_sec: 0, server_time: 1000 }]);
    render(<EmployeeScreen api={api} />);
    expect(await screen.findByRole("button", { name: /ابدأ الدوام/ })).toBeInTheDocument();
  });

  it("shows stop button when a session is open", async () => {
    const started = Math.floor(Date.now() / 1000) - 60;
    const api = makeApi([{ open_session: { id: "s1", started_at: started }, worked_sec: 60, server_time: started + 60 }]);
    render(<EmployeeScreen api={api} />);
    expect(await screen.findByRole("button", { name: /إنهاء الدوام/ })).toBeInTheDocument();
  });

  it("calls /session/start when start clicked", async () => {
    const api = makeApi([{ open_session: null, worked_sec: 0, server_time: 1000 }]);
    render(<EmployeeScreen api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /ابدأ الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/start"));
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/EmployeeScreen.test.jsx`
Expected: FAIL — cannot resolve `./EmployeeScreen.jsx`.

- [ ] **Step 3: Implement `web/src/components/Button.jsx`**

```jsx
export default function Button({ onClick, loading, disabled, variant, children }) {
  return (
    <button
      className={`btn ${variant === "stop" ? "btn-stop" : ""}`}
      onClick={onClick}
      disabled={loading || disabled}
    >
      {loading ? "..." : children}
    </button>
  );
}
```

- [ ] **Step 4: Implement `web/src/components/EmployeeScreen.jsx`**

```jsx
import { useEffect, useRef, useState } from "react";
import Button from "./Button.jsx";
import { formatDuration, formatHours, serverOffset, nowWithOffset } from "../time.js";

export default function EmployeeScreen({ api }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const offsetRef = useRef(0);

  async function refresh() {
    const s = await api.get("/me/status");
    offsetRef.current = serverOffset(s.server_time);
    setStatus(s);
  }

  useEffect(() => { refresh().catch((e) => setError(e.code || "INTERNAL_ERROR")); }, []);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function toggle() {
    setLoading(true); setError("");
    try {
      await api.post(status?.open_session ? "/session/stop" : "/session/start");
      await refresh();
    } catch (e) {
      setError(e.code || "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  }

  if (!status && !error) return <div className="card muted">جارٍ التحميل…</div>;

  const open = status?.open_session;
  const liveSec = open ? nowWithOffset(offsetRef.current) - open.started_at : 0;
  const todaySec = (status?.worked_sec ?? 0) + (open ? liveSec : 0);

  return (
    <div className="card" style={{ textAlign: "center", maxWidth: 420, margin: "40px auto" }}>
      <div style={{ fontSize: "2.4rem", fontWeight: 700, margin: "12px 0" }}>
        {open ? formatDuration(liveSec) : "0:00:00"}
      </div>
      <Button onClick={toggle} loading={loading} variant={open ? "stop" : "start"}>
        {open ? "إنهاء الدوام" : "ابدأ الدوام"}
      </Button>
      <div className="muted" style={{ marginTop: 16 }}>
        مجموع اليوم: {formatHours(todaySec)} ساعة
      </div>
      {error && <div className="error" style={{ marginTop: 12 }}>حدث خطأ، حاول مرة أخرى</div>}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd web && npx vitest run src/components/EmployeeScreen.test.jsx`
Expected: PASS (all 3).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Button.jsx web/src/components/EmployeeScreen.jsx web/src/components/EmployeeScreen.test.jsx
git commit -m "feat(web): employee Start/Stop screen with live server-time timer"
```

---

## Task 4: Manager panels — Live, Report (+CSV), Settings, Edit modal

The manager-only dashboard: a tabbed shell with "who's working now" (30s refresh), a period report table with completion coloring and CSV export, a settings form, and a session edit modal with a mandatory reason. Split into components but delivered together because they share the dashboard shell and the same `api`.

**Files:**
- Create: `web/src/components/ManagerDashboard.jsx`, `web/src/components/LivePanel.jsx`, `web/src/components/ReportPanel.jsx`, `web/src/components/SettingsPanel.jsx`, `web/src/components/SessionEditModal.jsx`
- Test: `web/src/components/LivePanel.test.jsx`, `web/src/components/ReportPanel.test.jsx`, `web/src/components/SessionEditModal.test.jsx`

**Interfaces:**
- Consumes: `api`, time helpers. Backend: `GET /admin/live` (`{ server_time, employees:[{user_id,name,email,session_id,started_at}] }`), `GET /admin/report?from=&to=` (`{ from,to,timezone,daily_target_hours, employees:[{user_id,name,email,worked_sec,sessions_count,days_present,auto_closed}] }`), `GET /admin/sessions?from=&to=&user_id=`, `PATCH /admin/sessions/:id` (`{started_at,ended_at,reason}`), `GET /admin/export.csv?from=&to=`, `GET /admin/settings`, `PUT /admin/settings`.
- Produces:
  - `ManagerDashboard({ api })` — tab state `"live"|"report"|"settings"`, renders the active panel.
  - `LivePanel({ api })`, `ReportPanel({ api })`, `SettingsPanel({ api })`.
  - `SessionEditModal({ api, session, onClose, onSaved })` — start/end datetime-local + reason; PATCHes; calls `onSaved` on success.
  - Period presets: `todayRange()`, `weekRange()`, `monthRange()` → `{ from, to }` UNIX seconds (defined in `ReportPanel.jsx`).

- [ ] **Step 1: Write failing test for `LivePanel`**

`web/src/components/LivePanel.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LivePanel from "./LivePanel.jsx";

describe("LivePanel", () => {
  it("marks open sessions as working and closed as offline", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      employees: [
        { user_id: "a", name: "أحمد", started_at: now - 120, session_id: "s1" },
        { user_id: "b", name: "سارة", started_at: null, session_id: null },
      ],
    })) };
    render(<LivePanel api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("سارة")).toBeInTheDocument();
    expect(screen.getAllByText(/شغّال الآن/).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/components/LivePanel.test.jsx`
Expected: FAIL — cannot resolve `./LivePanel.jsx`.

- [ ] **Step 3: Implement `web/src/components/LivePanel.jsx`**

```jsx
import { useEffect, useRef, useState } from "react";
import { formatDuration, serverOffset, nowWithOffset } from "../time.js";

export default function LivePanel({ api }) {
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
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { clearInterval(poll); clearInterval(t); };
  }, []);

  if (!data) return <div className="muted">جارٍ التحميل…</div>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr><th>الموظف</th><th>الحالة</th><th>المدة</th></tr></thead>
      <tbody>
        {data.employees.map((e) => {
          const working = e.session_id != null;
          const dur = working ? nowWithOffset(offsetRef.current) - e.started_at : 0;
          return (
            <tr key={e.user_id}>
              <td>{e.name}</td>
              <td style={{ color: working ? "var(--positive)" : "var(--muted)" }}>
                {working ? "شغّال الآن" : "غير متصل"}
              </td>
              <td>{working ? formatDuration(dur) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/LivePanel.test.jsx`
Expected: PASS.

- [ ] **Step 5: Write failing test for `ReportPanel`**

`web/src/components/ReportPanel.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ReportPanel from "./ReportPanel.jsx";

describe("ReportPanel", () => {
  it("renders per-employee worked hours from the report", async () => {
    const api = { get: vi.fn(async (p) => {
      if (p.startsWith("/admin/report")) return {
        from: 0, to: 1, timezone: "Asia/Riyadh", daily_target_hours: 8,
        employees: [{ user_id: "a", name: "أحمد", worked_sec: 3600, sessions_count: 1, days_present: 1, auto_closed: 0 }],
      };
      return { sessions: [] };
    }) };
    render(<ReportPanel api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("1.00")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `cd web && npx vitest run src/components/ReportPanel.test.jsx`
Expected: FAIL — cannot resolve `./ReportPanel.jsx`.

- [ ] **Step 7: Implement `web/src/components/ReportPanel.jsx`**

```jsx
import { useEffect, useState } from "react";
import { formatHours } from "../time.js";
import SessionEditModal from "./SessionEditModal.jsx";

export function todayRange() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - 86400, to };
}
export function weekRange() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - 7 * 86400, to };
}
export function monthRange() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - 30 * 86400, to };
}

function completionColor(pct) {
  if (pct >= 90) return "var(--positive)";
  if (pct >= 60) return "var(--warning)";
  return "var(--negative)";
}

export default function ReportPanel({ api }) {
  const [range, setRange] = useState(weekRange());
  const [report, setReport] = useState(null);
  const [detail, setDetail] = useState(null); // { user_id, name, sessions }
  const [editing, setEditing] = useState(null); // a session row

  async function load() {
    const r = await api.get(`/admin/report?from=${range.from}&to=${range.to}`);
    setReport(r);
  }
  useEffect(() => { load().catch(() => {}); }, [range.from, range.to]);

  async function openDetail(emp) {
    const d = await api.get(`/admin/sessions?from=${range.from}&to=${range.to}&user_id=${emp.user_id}`);
    setDetail({ ...emp, sessions: d.sessions });
  }

  if (!report) return <div className="muted">جارٍ التحميل…</div>;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className="btn" onClick={() => setRange(todayRange())}>اليوم</button>
        <button className="btn" onClick={() => setRange(weekRange())}>الأسبوع</button>
        <button className="btn" onClick={() => setRange(monthRange())}>الشهر</button>
        <a className="btn" href={`/admin/export.csv?from=${range.from}&to=${range.to}`}>تصدير CSV</a>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>الموظف</th><th>الساعات</th><th>الهدف</th><th>الإنجاز</th><th>أيام</th><th>تلقائي</th></tr></thead>
        <tbody>
          {report.employees.map((e) => {
            const target = e.days_present * report.daily_target_hours;
            const workedH = Number(formatHours(e.worked_sec));
            const pct = target > 0 ? Math.round((workedH / target) * 100) : 0;
            return (
              <tr key={e.user_id} style={{ cursor: "pointer" }} onClick={() => openDetail(e)}>
                <td>{e.name}</td>
                <td>{formatHours(e.worked_sec)}</td>
                <td>{target.toFixed(2)}</td>
                <td style={{ color: completionColor(pct) }}>{pct}%</td>
                <td>{e.days_present}</td>
                <td>{e.auto_closed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {detail && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ color: "var(--subheading)" }}>جلسات: {detail.name}</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th>البداية</th><th>النهاية</th><th>الإغلاق</th><th></th></tr></thead>
            <tbody>
              {detail.sessions.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.started_at * 1000).toLocaleString("en-GB")}</td>
                  <td>{s.ended_at ? new Date(s.ended_at * 1000).toLocaleString("en-GB") : "مفتوحة"}</td>
                  <td>{s.closed_by ?? "—"}</td>
                  <td><button className="btn" onClick={() => setEditing(s)}>تعديل</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SessionEditModal
          api={api}
          session={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); if (detail) await openDetail(detail); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run to verify pass**

Run: `cd web && npx vitest run src/components/ReportPanel.test.jsx`
Expected: FAIL — `SessionEditModal` not yet created. This is expected; create it in Step 9 before re-running.

- [ ] **Step 9: Write failing test for `SessionEditModal`, then implement it**

`web/src/components/SessionEditModal.test.jsx`:

```jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SessionEditModal from "./SessionEditModal.jsx";

describe("SessionEditModal", () => {
  const base = { id: "s1", started_at: 1000, ended_at: 4600 };

  it("blocks save without a reason", async () => {
    const api = { patch: vi.fn() };
    render(<SessionEditModal api={api} session={base} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText(/سبب التعديل مطلوب/)).toBeInTheDocument();
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

`web/src/components/SessionEditModal.jsx`:

```jsx
import { useState } from "react";

// datetime-local <-> unix seconds (local wall time, no TZ math — matches display).
const toLocalInput = (sec) => {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
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
      await api.patch(`/admin/sessions/${session.id}`, {
        started_at: fromLocalInput(start),
        ended_at: fromLocalInput(end),
        reason: reason.trim(),
      });
      onSaved();
    } catch (e) {
      setError(e.code === "INVALID_TIMES" ? "الأوقات غير صحيحة" : "حدث خطأ، حاول مرة أخرى");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center" }}>
      <div className="card" style={{ width: 360 }}>
        <h3 style={{ color: "var(--subheading)" }}>تعديل الجلسة</h3>
        <label>البداية<br /><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <br /><br />
        <label>النهاية<br /><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <br /><br />
        <textarea placeholder="سبب التعديل" value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: "100%" }} rows={2} />
        {error && <div className="error">{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={save} disabled={saving}>حفظ</button>
          <button className="btn" style={{ background: "var(--muted)" }} onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Run report + modal tests to verify pass**

Run: `cd web && npx vitest run src/components/ReportPanel.test.jsx src/components/SessionEditModal.test.jsx`
Expected: PASS (3 total).

- [ ] **Step 11: Implement `SettingsPanel` and `ManagerDashboard` (no new test file; covered by manual + App smoke in Task 5)**

`web/src/components/SettingsPanel.jsx`:

```jsx
import { useEffect, useState } from "react";

export default function SettingsPanel({ api }) {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => {}); }, []);
  if (!s) return <div className="muted">جارٍ التحميل…</div>;

  async function save() {
    setMsg(""); setError("");
    try {
      const saved = await api.put("/admin/settings", {
        timezone: s.timezone,
        daily_target_hours: Number(s.daily_target_hours),
        max_session_hours: Number(s.max_session_hours),
        work_start: s.work_start || null,
      });
      setS(saved); setMsg("تم الحفظ");
    } catch (e) {
      setError(e.code === "INVALID_TIMEZONE" ? "المنطقة الزمنية غير صحيحة"
        : e.code === "INVALID_HOURS" ? "الساعات غير صحيحة"
        : e.code === "INVALID_WORK_START" ? "وقت البداية غير صحيح"
        : "حدث خطأ، حاول مرة أخرى");
    }
  }
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });

  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <label>المنطقة الزمنية<br /><input value={s.timezone} onChange={set("timezone")} /></label><br /><br />
      <label>الهدف اليومي (ساعات)<br /><input type="number" step="0.5" value={s.daily_target_hours} onChange={set("daily_target_hours")} /></label><br /><br />
      <label>حد الجلسة (ساعات)<br /><input type="number" step="0.5" value={s.max_session_hours} onChange={set("max_session_hours")} /></label><br /><br />
      <label>بداية الدوام (HH:MM)<br /><input value={s.work_start ?? ""} onChange={set("work_start")} /></label><br /><br />
      <button className="btn" onClick={save}>حفظ</button>
      {msg && <span style={{ color: "var(--positive)", marginRight: 8 }}>{msg}</span>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
```

`web/src/components/ManagerDashboard.jsx`:

```jsx
import { useState } from "react";
import LivePanel from "./LivePanel.jsx";
import ReportPanel from "./ReportPanel.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const TABS = [
  { key: "live", label: "شغّال الآن" },
  { key: "report", label: "التقرير" },
  { key: "settings", label: "الإعدادات" },
];

export default function ManagerDashboard({ api }) {
  const [tab, setTab] = useState("live");
  return (
    <div style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key} className="btn"
            style={{ background: tab === t.key ? "var(--accent)" : "var(--muted)" }}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === "live" && <LivePanel api={api} />}
      {tab === "report" && <ReportPanel api={api} />}
      {tab === "settings" && <SettingsPanel api={api} />}
    </div>
  );
}
```

- [ ] **Step 12: Run the whole web test suite**

Run: `cd web && npx vitest run`
Expected: PASS — all suites (time, api, auth, EmployeeScreen, LivePanel, ReportPanel, SessionEditModal).

- [ ] **Step 13: Commit**

```bash
git add web/src/components
git commit -m "feat(web): manager dashboard — live, report+CSV, settings, session edit modal"
```

---

## Task 5: App shell — auth flow, role routing, 401-retry, dev login UI

Wires everything together: on mount, obtain a token (GHL SSO in an iframe, or a dev-login picker locally), hold token+user in memory, route managers to the dashboard and employees to their screen, and on any `401` redo the handshake once before showing an error screen.

**Files:**
- Modify: `web/src/App.jsx` (replace placeholder)
- Test: `web/src/App.test.jsx`

**Interfaces:**
- Consumes: `createApi`, `ssoLogin`, `devLogin`, `EmployeeScreen`, `ManagerDashboard`, `ApiError`.
- Produces: `App()` — default export mounted by `main.jsx`. Detects dev mode via `import.meta.env.DEV`. In dev with no token, shows two buttons ("دخول كموظف" / "دخول كمدير") calling dev-login. In prod, runs `ssoLogin` on mount. Holds `tokenRef` so `createApi(() => tokenRef.current)` always reads the latest token; a 401 from any call triggers one silent re-auth then surfaces an error screen.

- [ ] **Step 1: Write the failing test**

`web/src/App.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App.jsx";

describe("App", () => {
  beforeEach(() => { global.fetch = vi.fn(); });

  it("in dev shows role picker when no token", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /دخول كمدير/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /دخول كموظف/ })).toBeInTheDocument();
  });

  it("dev manager login routes to dashboard", async () => {
    global.fetch.mockImplementation(async (path) => {
      if (path === "/auth/dev-login") return { ok: true, status: 200, json: async () => ({ token: "T", user: { role: "manager", name: "مدير تجريبي" } }) };
      if (path.startsWith("/admin/live")) return { ok: true, status: 200, json: async () => ({ server_time: 1, employees: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /دخول كمدير/ }));
    expect(await screen.findByRole("button", { name: /شغّال الآن/ })).toBeInTheDocument();
  });

  it("dev employee login routes to employee screen", async () => {
    global.fetch.mockImplementation(async (path) => {
      if (path === "/auth/dev-login") return { ok: true, status: 200, json: async () => ({ token: "T", user: { role: "employee", name: "موظف تجريبي" } }) };
      if (path.startsWith("/me/status")) return { ok: true, status: 200, json: async () => ({ open_session: null, worked_sec: 0, server_time: 1 }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /دخول كموظف/ }));
    expect(await screen.findByRole("button", { name: /ابدأ الدوام/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run src/App.test.jsx`
Expected: FAIL — current `App.jsx` is the placeholder, no role-picker buttons.

- [ ] **Step 3: Implement `web/src/App.jsx`**

```jsx
import { useEffect, useRef, useState } from "react";
import { createApi, ApiError } from "./api.js";
import { ssoLogin, devLogin } from "./auth.js";
import EmployeeScreen from "./components/EmployeeScreen.jsx";
import ManagerDashboard from "./components/ManagerDashboard.jsx";

const IS_DEV = import.meta.env.DEV;

export default function App() {
  const tokenRef = useRef(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const retriedRef = useRef(false);

  // createApi reads the latest token, and re-auths once on 401.
  const api = useRef(null);
  if (!api.current) {
    const base = createApi(() => tokenRef.current);
    const wrap = (fn) => async (...args) => {
      try { return await fn(...args); }
      catch (e) {
        if (e instanceof ApiError && e.status === 401 && !retriedRef.current && !IS_DEV) {
          retriedRef.current = true;
          await doSsoLogin();
          return await fn(...args);
        }
        throw e;
      }
    };
    api.current = { get: wrap(base.get), post: wrap(base.post), put: wrap(base.put), patch: wrap(base.patch), rawUrl: base.rawUrl };
  }

  async function doSsoLogin() {
    const { token, user } = await ssoLogin(createApi(() => null));
    tokenRef.current = token;
    setUser(user);
  }

  useEffect(() => {
    if (IS_DEV) { setReady(true); return; } // wait for role picker
    doSsoLogin().catch((e) => setError(e.code || e.message || "AUTH_FAILED")).finally(() => setReady(true));
  }, []);

  async function doDevLogin(role) {
    try {
      const { token, user } = await devLogin(createApi(() => null), role);
      tokenRef.current = token;
      setUser(user);
    } catch (e) { setError(e.code || "AUTH_FAILED"); }
  }

  if (error) return <div className="card error" style={{ maxWidth: 420, margin: "40px auto" }}>انتهت الجلسة، أعد فتح الصفحة</div>;
  if (!ready) return <div className="card muted" style={{ maxWidth: 420, margin: "40px auto" }}>جارٍ التحقق…</div>;

  if (!user) {
    if (IS_DEV) {
      return (
        <div className="card" style={{ maxWidth: 420, margin: "40px auto", textAlign: "center" }}>
          <p className="muted">وضع التطوير</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn" onClick={() => doDevLogin("employee")}>دخول كموظف</button>
            <button className="btn" onClick={() => doDevLogin("manager")}>دخول كمدير</button>
          </div>
        </div>
      );
    }
    return <div className="card muted" style={{ maxWidth: 420, margin: "40px auto" }}>جارٍ التحقق…</div>;
  }

  return user.role === "manager"
    ? <ManagerDashboard api={api.current} />
    : <EmployeeScreen api={api.current} />;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/App.test.jsx`
Expected: PASS (all 3).

- [ ] **Step 5: Run the full web suite + build**

```bash
cd web && npx vitest run && npm run build && cd ..
ls public/index.html
```

Expected: all tests PASS; build writes `public/`.

- [ ] **Step 6: Manual end-to-end check against the running backend**

With a local DB and the backend running in dev (`node --env-file=.env src/server.js`), run the Vite dev server (`cd web && npm run dev`) and open `http://localhost:5173`:
- Click "دخول كمدير" → dashboard tabs appear; Live/Report/Settings load without console errors.
- Click "دخول كموظف" → Start button; click it, timer counts up; refresh totals.
Then verify the production-build path: `curl -s localhost:3000/ | grep -q root` (served from `public/`).
**Report what you saw (screenshots or console-clean confirmation).**

- [ ] **Step 7: Commit**

```bash
git add web/src/App.jsx web/src/App.test.jsx
git commit -m "feat(web): app shell — SSO/dev auth, role routing, 401 retry-once"
```

---

## Task 6: Wire the build into deploy docs and flip section-18 checkboxes

Final housekeeping so a fresh deploy picks up the frontend: confirm the root `build` script is what Hostinger runs, update `PROJECT.md` status, and re-run the backend smoke test to prove nothing regressed.

**Files:**
- Modify: `PROJECT.md` (sections 3 status line, 16 table, 18 checkboxes)
- Test: `scripts/smoke-test.mjs` (re-run, must stay green)

**Interfaces:**
- Consumes: everything above.
- Produces: updated docs; green smoke test.

- [ ] **Step 1: Update `PROJECT.md` status**

- Top status line (near line 3): change `Frontend لسا ما بلّش` → `Frontend مبني ومُختبر بالوحدات · لسا ما صار deploy`.
- Section 16 table: set the "واجهة React RTL" and "خدمة الواجهة static من Hono" rows to `✅ خلص`.
- Section 18: check every box (`- [x]`) that this plan completed, and add a one-line note: `Dev login: POST /auth/dev-login (NODE_ENV != production فقط).`

- [ ] **Step 2: Re-run the backend smoke test (regression gate)**

With the backend running in dev mode:

```bash
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=<same-as-.env> npm run test:smoke
```

Expected: **23 passed, 0 failed** (20 original + 3 dev-login). **Report the exact final line.**

- [ ] **Step 3: Run the full web test suite once more (regression gate)**

```bash
cd web && npx vitest run
```

Expected: all suites pass. **Report the summary line.**

- [ ] **Step 4: Commit**

```bash
git add PROJECT.md
git commit -m "docs: mark React frontend + dev-login done in PROJECT.md"
```

---

## Self-Review

**1. Spec coverage (PROJECT.md §10 + §18):**
- §18.1 `web/` Vite+React building to `../public` → Task 1. ✅
- §18.2 `serveStatic` from `public/` with `index.html` fallback, API before static → Task 1 Step 4. ✅
- §18.3 root `build` script → Task 1 Step 5. ✅
- §18.4 dev auth gated by `NODE_ENV !== 'production'` → Task 0 (`/auth/dev-login`). ✅
- §10 employee screen (big button, live server-time timer, today/week totals, loading state) → Task 3. ✅
- §10 manager: live (30s refresh) → Task 4 LivePanel; report (period filter, target = days×daily_target, completion coloring, days, auto-closed) → ReportPanel; employee detail + edit modal (mandatory reason) → ReportPanel + SessionEditModal; CSV export → ReportPanel link; settings → SettingsPanel. ✅
- §10 RTL, Western digits, brand colors, token in memory, 401 re-handshake once, server_time timers → Global Constraints + Task 1 (styles/index.html) + Task 2 (time) + Task 5 (App 401 retry). ✅
- Role gating (dashboard managers only) → enforced server-side (`managerOnly`), mirrored by App routing in Task 5. ✅

**2. Placeholder scan:** No "TBD/handle edge cases/similar to Task N" left. Error handling is shown concretely (typed `ApiError`, per-code Arabic messages). Every code step has a full code block. One deliberate cross-task reference: Task 4 Step 8 predicts a fail because `SessionEditModal` lands in Step 9 — the sequencing is spelled out, not a placeholder.

**3. Type consistency:**
- `createApi(getToken)` returns `{get,post,put,patch,rawUrl}` — used identically in Tasks 3,4,5. ✅
- `ApiError { status, code }` — thrown in Task 2, caught by code in Tasks 3,4,5. ✅
- `issueSession({userId,loc,role,name,email})` → `{token,user}` — defined Task 0, consumed by both auth routes. ✅
- Time helpers `formatDuration`, `formatHours`, `serverOffset`, `nowWithOffset` — defined Task 2, used in Tasks 3,4 with matching signatures. ✅
- `SessionEditModal({api,session,onClose,onSaved})` — defined and used with the same props in Task 4. ✅
- Backend response shapes referenced in components match `src/server.js` (`/me/status`, `/admin/live`, `/admin/report`, `/admin/sessions`). ✅

No gaps found.
