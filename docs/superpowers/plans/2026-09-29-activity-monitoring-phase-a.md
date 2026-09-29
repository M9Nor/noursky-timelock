# Activity Monitoring — Phase A (Connection & Collection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect TimeClock to GHL through OAuth and signed webhooks, store per-employee activity metadata (who / when / kind — never content) for accounts that switch monitoring on, and show the manager whether the connection works — so phase B can build detection on verified data.

**Architecture:** Migration 004 creates every table/column the whole feature needs (phase B included). Two pure, unit-tested modules do the risky parts: `src/ghlWebhook.js` (Ed25519 signature check against GHL's public key + payload parsing) and `src/tokenCrypto.js` (AES-256-GCM for stored OAuth tokens); `src/ghlOAuth.js` exchanges the install code. `src/server.js` gains `POST /ghl/webhook`, `GET /ghl/oauth/callback`, `GET /admin/ghl-connection`, two settings fields and a 90-day retention purge. The settings screen gets the toggle, the idle threshold and a live connection status.

**Tech Stack:** Node 20 ESM · Hono 4 · mysql2 · `node:crypto` (Ed25519, AES-256-GCM) · `node:test` · React 18 · Vitest 2 · MariaDB 11 locally (Docker `timeclock-db`)

**Spec:** `docs/superpowers/specs/2026-09-29-activity-monitoring-design.md` (phase A = §2, §3, §4, §5.1, §5.2, §5.7, and the settings part of §6)

## Global Constraints

- Plain ESM JavaScript, 2-space indent, semicolons. No new npm dependencies (everything is `node:crypto` / `fetch`).
- SQL must run on **both MySQL 8 and MariaDB 10.2+**: no `IF NOT EXISTS` on columns/keys, no `RETURNING`, no `INSERT … AS alias`, no partial indexes. Upserts use `ON DUPLICATE KEY UPDATE col = VALUES(col)`.
- `location_id` / `user_id` for authenticated routes come only from `c.get("claims")`. `/admin/*` routes use `authed, managerOnly`. `/ghl/webhook` and `/ghl/oauth/callback` are called by GHL, not by a signed-in user: the webhook is authenticated **only** by its `X-GHL-Signature`.
- **Never store message or call content.** Only who, when, kind, message type and source.
- Activity is collected only for locations with `settings.activity_monitoring = 1` (off by default).
- The test signing key is accepted **only when `NODE_ENV !== "production"`** (same rule as dev-login).
- Secrets (`GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `TOKEN_ENC_KEY`) live only in Hostinger env vars; the feature degrades gracefully when they are absent. They are **not** added to `REQUIRED`.
- Errors are `{ error: "CODE" }` via `HttpError` for JSON routes; every new code is documented in `PROJECT.md` §8.
- Migration order: `migrations/004_activity_monitoring.sql` is applied to production **before** this code ships.
- UI: Arabic, RTL, Western digits.

## Deliberate refinements of the spec (apply the spec amendment in Task 3)

1. `activity_events.user_id` is **nullable**, and rows also keep `message_type` and `source`. Phase A collects every `OutboundMessage` of a monitored location so the Innova verification can see what automated messages look like; phase B decides what counts (known employees, not automated).
2. Install / uninstall events are recorded for **any** location whose event is correctly signed (correction after the final review: a valid signature proves the event is from GHL, not that it is for our app, because GHL signs every app's webhooks with one key; so install/uninstall must also carry our `GHL_APP_ID` when that is set), not only locations that already opened TimeClock.
3. `GET /admin/ghl-connection` also returns `events_24h`, and runs the retention purge lazily (plus the timer).
4. New error code `INVALID_ACTIVITY_MONITORING` (non-boolean toggle).

## Shared commands

```bash
# restart the local API after changing src/
cd /Users/Yasin/Projects/superpowers/noursky-timelock
pkill -f "node --env-file=.env src/server.js"; nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health >/dev/null; do sleep 1; done; echo up

# smoke (Docker timeclock-db running, API up)
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) npm run test:smoke 2>&1 | grep -E "FAIL|SKIP|passed"

npm run test:unit                      # node:test
cd web && npx vitest run               # frontend
```

Baseline before Task 1: smoke **96 passed, 0 failed**; unit **15**; frontend **91**. Local `.env` has `NODE_ENV=development` and no `GHL_CLIENT_ID`.

## File map

| File | Change |
|---|---|
| `migrations/004_activity_monitoring.sql`, `migrations/README.md`, `schema.sql` | DDL (T1) |
| `src/server.js` | settings fields + `/admin/ghl-connection` (T1); webhook route + retention (T3); OAuth callback (T4) |
| `src/tokenCrypto.js`, `src/tokenCrypto.test.mjs` | new (T2) |
| `src/ghlWebhook.js`, `src/ghlWebhook.test.mjs` | new (T2) |
| `scripts/fixtures/ghl-test-webhook-key.mjs` | new — test-only signing key (T2) |
| `src/ghlOAuth.js`, `src/ghlOAuth.test.mjs` | new (T4) |
| `package.json` | `test:unit` lists all `src/*.test.mjs` (T2, T4) |
| `scripts/smoke-test.mjs` | settings (T1), webhook (T3), OAuth (T4) blocks; cleanup tables |
| `PROJECT.md`, spec | docs (T1, T3, T4) |
| `web/src/components/SettingsPanel.jsx` (+test) | toggle, idle minutes, connection status (T5) |

---

### Task 1: Migration 004, settings fields and the connection endpoint

**Files:**
- Create: `migrations/004_activity_monitoring.sql`
- Modify: `migrations/README.md`, `schema.sql`, `src/server.js` (`getSettings`, `PUT /admin/settings`, new `GET /admin/ghl-connection`), `scripts/smoke-test.mjs`, `PROJECT.md`

**Interfaces:**
- Produces: tables `ghl_installs`, `activity_events`, `activity_alerts`; columns `settings.activity_monitoring` / `idle_minutes` / `activity_monitoring_since`, `sessions.activity_count` / `last_activity_at` / `longest_idle_sec`.
  `GET/PUT /admin/settings` carry `activity_monitoring` (boolean), `idle_minutes` (int 10–240, default 30), `activity_monitoring_since` (read-only; set to now when monitoring turns on). Errors `400 INVALID_IDLE_MINUTES`, `400 INVALID_ACTIVITY_MONITORING`.
  `GET /admin/ghl-connection` → `{ installed: boolean, has_activity_scope: boolean, last_event_at: number|null, events_24h: number }`. Constant `ACTIVITY_SCOPE = "conversations/message.readonly"` in `src/server.js`.
  Smoke: `cleanupLocation` also clears `activity_events`, `activity_alerts`, `ghl_installs`; fixture `AWLOC`, `AWM` (manager token), `awPolicy(extra)`, ending with `await cleanupLocation(AWLOC);`.

- [ ] **Step 1: Write the migration**

Create `migrations/004_activity_monitoring.sql`:

```sql
-- 004 · Activity monitoring (phase A creates everything phases A and B need).
-- Apply BEFORE deploying the activity-monitoring code. Old code keeps working on the
-- migrated schema (new columns have defaults; new tables are unused by it).
-- schema.sql already includes all of this. Portable across MySQL 8 and MariaDB 10.2+.
-- Several statements, not re-runnable as a whole: if it stops midway, check
-- SHOW COLUMNS / SHOW TABLES and run only the remaining statements.
ALTER TABLE settings
  ADD COLUMN activity_monitoring TINYINT(1) NOT NULL DEFAULT 0 AFTER break_policy_since;
ALTER TABLE settings
  ADD COLUMN idle_minutes INT NOT NULL DEFAULT 30 AFTER activity_monitoring;
ALTER TABLE settings
  ADD COLUMN activity_monitoring_since BIGINT NULL AFTER idle_minutes;

ALTER TABLE sessions
  ADD COLUMN activity_count INT NULL AFTER note;
ALTER TABLE sessions
  ADD COLUMN last_activity_at BIGINT NULL AFTER activity_count;
ALTER TABLE sessions
  ADD COLUMN longest_idle_sec INT NULL AFTER last_activity_at;

CREATE TABLE IF NOT EXISTS ghl_installs (
  location_id       VARCHAR(64)   NOT NULL PRIMARY KEY,
  company_id        VARCHAR(64)   NULL,
  access_token_enc  TEXT          NULL,
  refresh_token_enc TEXT          NULL,
  token_expires_at  BIGINT        NULL,
  scopes            VARCHAR(1000) NULL,
  installed_at      BIGINT        NULL,
  uninstalled_at    BIGINT        NULL,
  last_event_at     BIGINT        NULL,
  updated_at        BIGINT        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Metadata only: never the content of a message or call.
CREATE TABLE IF NOT EXISTS activity_events (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  location_id  VARCHAR(64)  NOT NULL,
  user_id      VARCHAR(64)  NULL,
  occurred_at  BIGINT       NOT NULL,
  kind         ENUM('message','call','comment','other') NOT NULL,
  message_type VARCHAR(40)  NULL,
  source       VARCHAR(60)  NULL,
  webhook_id   VARCHAR(100) NOT NULL,
  created_at   BIGINT       NOT NULL,
  UNIQUE KEY ux_activity_webhook (webhook_id),
  KEY ix_activity_user_time (location_id, user_id, occurred_at),
  KEY ix_activity_time (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_alerts (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  location_id      VARCHAR(64)  NOT NULL,
  user_id          VARCHAR(64)  NOT NULL,
  session_id       CHAR(36)     NULL,
  kind             ENUM('idle','working_not_clocked_in') NOT NULL,
  from_at          BIGINT       NOT NULL,
  to_at            BIGINT       NULL,
  detected_at      BIGINT       NOT NULL,
  status           ENUM('open','resolved','dismissed') NOT NULL DEFAULT 'open',
  resolution       ENUM('dismissed','ended_at_last_activity','clocked_in','late_activity') NULL,
  resolved_by      VARCHAR(64)  NULL,
  resolved_at      BIGINT       NULL,
  employee_note    VARCHAR(300) NULL,
  employee_note_at BIGINT       NULL,
  -- One ongoing idle stretch per session; one open not-clocked-in alert per employee.
  idle_open_key    CHAR(36) GENERATED ALWAYS AS
                     (IF(kind = 'idle' AND status = 'open' AND to_at IS NULL, session_id, NULL)) STORED,
  nci_open_key     VARCHAR(129) GENERATED ALWAYS AS
                     (IF(kind = 'working_not_clocked_in' AND status = 'open', CONCAT(location_id, '|', user_id), NULL)) STORED,
  UNIQUE KEY ux_alert_idle_open (idle_open_key),
  UNIQUE KEY ux_alert_nci_open (nci_open_key),
  KEY ix_alert_loc_status (location_id, status),
  KEY ix_alert_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

In `migrations/README.md`, append to the `## Applied` table:

```markdown
| `004_activity_monitoring.sql` | pending | apply before deploying activity monitoring phase A |
```

- [ ] **Step 2: Mirror it in `schema.sql`**

In `CREATE TABLE IF NOT EXISTS settings`, after the `break_policy_since` line add:

```sql
  activity_monitoring       TINYINT(1)  NOT NULL DEFAULT 0,
  idle_minutes              INT         NOT NULL DEFAULT 30,
  activity_monitoring_since BIGINT      NULL,
```

In `CREATE TABLE IF NOT EXISTS sessions`, after the `note` line add:

```sql
  activity_count   INT         NULL,
  last_activity_at BIGINT      NULL,
  longest_idle_sec INT         NULL,
```

Append the three `CREATE TABLE IF NOT EXISTS` statements (`ghl_installs`, `activity_events`, `activity_alerts`) from Step 1, verbatim, at the end of `schema.sql`.

- [ ] **Step 3: Apply locally**

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
set -a; . ./.env; set +a
docker exec -i timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/004_activity_monitoring.sql
docker exec timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "SHOW COLUMNS FROM settings LIKE 'activity%'; SHOW TABLES LIKE 'activity%'; SHOW TABLES LIKE 'ghl_installs';"
```

Expected: `activity_monitoring`, `activity_monitoring_since`; tables `activity_alerts`, `activity_events`, `ghl_installs`.

- [ ] **Step 4: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, in `cleanupLocation`, replace

```js
    for (const table of ["breaks", "edits_log", "sessions", "employees", "settings"]) {
```

with

```js
    for (const table of ["activity_events", "activity_alerts", "ghl_installs", "breaks", "edits_log", "sessions", "employees", "settings"]) {
```

Then insert immediately **after** `await cleanupLocation(TDLOC);`:

```js

// --- Activity monitoring (phase A): settings, connection status, webhooks, OAuth. ---
const AWLOC = `${LOC}-aw`;
const awMgr = await sso({ userId: `${AWLOC}-m1`, role: "admin", type: "account", activeLocation: AWLOC, userName: "مدير النشاط", email: "awm@x.com" });
const awEmp = await sso({ userId: `${AWLOC}-u1`, role: "user", type: "account", activeLocation: AWLOC, userName: "موظف النشاط", email: "awe@x.com" });
const AWM = awMgr.body?.token, AWE = awEmp.body?.token;
const awBase = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: null, late_grace_minutes: 15, note_on_stop: "off", break_mode: "off" };
const awPolicy = (extra) => call(AWM, "PUT", "/admin/settings", { ...awBase, ...extra });

const awDefaults = await call(AWM, "GET", "/admin/settings");
check("activity monitoring is off by default with a 30-minute idle threshold",
  awDefaults.body?.activity_monitoring === false && awDefaults.body?.idle_minutes === 30 && awDefaults.body?.activity_monitoring_since === null,
  `(${JSON.stringify({ m: awDefaults.body?.activity_monitoring, i: awDefaults.body?.idle_minutes, s: awDefaults.body?.activity_monitoring_since })})`);
const awOnAt = Math.floor(Date.now() / 1000);
const awOn = await awPolicy({ activity_monitoring: true, idle_minutes: 45 });
check("switching monitoring on saves the threshold and stamps when it started",
  awOn.status === 200 && awOn.body?.activity_monitoring === true && awOn.body?.idle_minutes === 45
    && Math.abs(Number(awOn.body?.activity_monitoring_since) - awOnAt) <= 5,
  `(${JSON.stringify({ m: awOn.body?.activity_monitoring, i: awOn.body?.idle_minutes, s: awOn.body?.activity_monitoring_since })})`);
const awAgain = await awPolicy({ activity_monitoring: true, idle_minutes: 30 });
check("saving again while monitoring stays on keeps the original start",
  awAgain.body?.activity_monitoring_since === awOn.body?.activity_monitoring_since);
check("idle threshold outside 10–240 → 400",
  (await awPolicy({ activity_monitoring: true, idle_minutes: 5 })).body?.error === "INVALID_IDLE_MINUTES");
check("non-boolean monitoring toggle → 400",
  (await awPolicy({ activity_monitoring: "yes" })).body?.error === "INVALID_ACTIVITY_MONITORING");
const awConn0 = await call(AWM, "GET", "/admin/ghl-connection");
check("a location that never installed reports no connection",
  awConn0.status === 200 && awConn0.body?.installed === false && awConn0.body?.has_activity_scope === false
    && awConn0.body?.last_event_at === null && awConn0.body?.events_24h === 0,
  `(${JSON.stringify(awConn0.body)})`);

await cleanupLocation(AWLOC);
```

- [ ] **Step 5: Run to verify they fail**

Run the smoke command. Expected: the 6 new checks FAIL (fields missing, `404` on `/admin/ghl-connection`); the 96 earlier checks PASS.

- [ ] **Step 6: Implement in `src/server.js`**

Replace the `getSettings` return line

```js
  return st ? { ...st, breaks_enabled: Boolean(st.breaks_enabled), break_paid: Boolean(st.break_paid) } : null;
```

with

```js
  return st
    ? {
      ...st,
      breaks_enabled: Boolean(st.breaks_enabled),
      break_paid: Boolean(st.break_paid),
      activity_monitoring: Boolean(st.activity_monitoring),
    }
    : null;
```

In `PUT /admin/settings`, replace

```js
  const notePolicy = b.note_on_stop === undefined ? "off" : b.note_on_stop;
  if (!NOTE_POLICIES.includes(notePolicy)) throw new HttpError(400, "INVALID_NOTE_POLICY");
```

with

```js
  const notePolicy = b.note_on_stop === undefined ? "off" : b.note_on_stop;
  if (!NOTE_POLICIES.includes(notePolicy)) throw new HttpError(400, "INVALID_NOTE_POLICY");
  if (b.activity_monitoring !== undefined && typeof b.activity_monitoring !== "boolean") {
    throw new HttpError(400, "INVALID_ACTIVITY_MONITORING");
  }
  const monitoring = b.activity_monitoring === true;
  // Same empty-field rule as the grace: "" / null / absent mean the 30-minute default.
  const rawIdle = b.idle_minutes;
  const idleMinutes = rawIdle === undefined || rawIdle === null || rawIdle === "" ? 30 : Number(rawIdle);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 10 || idleMinutes > 240) {
    throw new HttpError(400, "INVALID_IDLE_MINUTES");
  }
```

In the same handler's `UPDATE`, replace

```js
                                                  break_policy_since, :t),
                         timezone = :tz, daily_target_hours = :target, work_start = :ws,
```

with

```js
                                                  break_policy_since, :t),
                         activity_monitoring_since = IF(activity_monitoring = 0 AND :monitoring = 1,
                                                        :t, activity_monitoring_since),
                         timezone = :tz, daily_target_hours = :target, work_start = :ws,
```

and replace

```js
                         note_on_stop = :notePolicy, updated_at = :t
```

with

```js
                         activity_monitoring = :monitoring, idle_minutes = :idleMinutes,
                         note_on_stop = :notePolicy, updated_at = :t
```

and in its params object replace

```js
      breakPaid: breakPaid ? 1 : 0, notePolicy, t: now(), loc,
```

with

```js
      breakPaid: breakPaid ? 1 : 0, notePolicy, t: now(), loc,
      monitoring: monitoring ? 1 : 0, idleMinutes,
```

(`activity_monitoring_since` is assigned before `activity_monitoring` for the same reason as `break_policy_since`: it must compare against the stored value.)

Insert immediately **before** `app.put("/admin/settings", …)`:

```js
// The read scope our Marketplace app requests for activity (spec §3).
const ACTIVITY_SCOPE = "conversations/message.readonly";

app.get("/admin/ghl-connection", authed, managerOnly, async (c) => {
  const { loc } = c.get("claims");
  const [row] = await q(
    "SELECT scopes, installed_at, uninstalled_at, last_event_at FROM ghl_installs WHERE location_id = :loc",
    { loc }
  );
  const [cnt] = await q(
    "SELECT COUNT(*) AS n FROM activity_events WHERE location_id = :loc AND occurred_at >= :since",
    { loc, since: now() - 86400 }
  );
  const scopes = String(row?.scopes ?? "").split(/[\s,]+/).filter(Boolean);
  return c.json({
    installed: Boolean(row?.installed_at && !row?.uninstalled_at),
    has_activity_scope: scopes.includes(ACTIVITY_SCOPE),
    last_event_at: row?.last_event_at == null ? null : Number(row.last_event_at),
    events_24h: Number(cnt.n),
  });
});

```

- [ ] **Step 7: Restart and run the smoke test**

Expected: **102 passed, 0 failed**.

- [ ] **Step 8: Document in `PROJECT.md`**

§7 settings table: add rows `activity_monitoring` (TINYINT(1), `0` — مراقبة النشاط من GHL، مطفاية افتراضياً), `idle_minutes` (INT, `30` — حد الخمول بالدقائق 10–240، بيستخدمه الكشف بالمرحلة ب), `activity_monitoring_since` (BIGINT NULL — وقت آخر تفعيل؛ الخمول ما بينحسب من قبله). §7 sessions: add `activity_count`, `last_activity_at`, `longest_idle_sec` (ملخص النشاط، NULL = ما كانت في مراقبة). Add a short §7 subsection for `ghl_installs`, `activity_events` (بيانات وصفية بس، ولا محتوى؛ بتنحذف بعد 90 يوم) and `activity_alerts` (للمرحلة ب).

§8 manager table: add

```markdown
| GET | `/admin/ghl-connection` | حالة الربط مع GHL لهالحساب: `{ installed, has_activity_scope, last_event_at, events_24h }` |
```

and extend the `PUT /admin/settings` row with `, activity_monitoring (boolean), idle_minutes (10–240، افتراضي 30)` in its body list and the note `وتفعيل المراقبة بيسجّل activity_monitoring_since = now`. Append to رموز الأخطاء:

```markdown
| `INVALID_IDLE_MINUTES` | 400 | حد الخمول مش رقم صحيح بين 10 و240 | حد الخمول لازم يكون بين 10 و240 دقيقة |
| `INVALID_ACTIVITY_MONITORING` | 400 | `activity_monitoring` مش boolean | إعداد مراقبة النشاط غير صحيح |
```

- [ ] **Step 9: Commit**

```bash
git add migrations schema.sql src/server.js scripts/smoke-test.mjs PROJECT.md
git commit -m "feat(activity): migration 004, monitoring settings and GHL connection status"
```

---

### Task 2: Signature verification, webhook parsing and token encryption (pure modules)

**Files:**
- Create: `src/ghlWebhook.js`, `src/ghlWebhook.test.mjs`, `src/tokenCrypto.js`, `src/tokenCrypto.test.mjs`, `scripts/fixtures/ghl-test-webhook-key.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `src/ghlWebhook.js`: `GHL_WEBHOOK_PUBLIC_KEY` (string), `TEST_WEBHOOK_PUBLIC_KEY` (string), `verifyGhlSignature(rawBody: string, signature: string|undefined, { allowTestKey = false } = {}) → boolean`, `parseWebhook(payload: object, receivedAt: number) →` one of
    `{ event: "install", locationId, companyId, webhookId }`, `{ event: "uninstall", locationId, companyId, webhookId }`,
    `{ event: "activity", locationId, webhookId, userId, kind: "message"|"call"|"comment", messageType, source, occurredAt }`,
    `{ event: "ignored", locationId, webhookId }` (fields may be `null`).
  - `src/tokenCrypto.js`: `encryptToken(plain: string, keyHex: string) → "v1:<iv>:<tag>:<ct>"`, `decryptToken(enc: string, keyHex: string) → string`; both throw on a key that is not 64 hex chars; `decryptToken` throws on tampering.
  - `scripts/fixtures/ghl-test-webhook-key.mjs`: `signTestWebhook(rawBody: string) → base64 signature`.

- [ ] **Step 1: Add the test-only signing key**

Create `scripts/fixtures/ghl-test-webhook-key.mjs`:

```js
// TEST-ONLY Ed25519 key for signing fake GHL webhooks in local tests. The server accepts
// its public half only when NODE_ENV !== "production" (see src/ghlWebhook.js), so this
// private key grants nothing on the live site. Never use it for anything else.
import { createPrivateKey, sign } from "node:crypto";

const TEST_WEBHOOK_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDicbCH0SGCKrYEZ40m3pIr/Kpc2oz2Ht0tK/u10Wtep
-----END PRIVATE KEY-----
`;

const key = createPrivateKey(TEST_WEBHOOK_PRIVATE_KEY_PEM);

/** Base64 Ed25519 signature of the exact body string, as GHL sends in X-GHL-Signature. */
export function signTestWebhook(rawBody) {
  return sign(null, Buffer.from(rawBody, "utf8"), key).toString("base64");
}
```

- [ ] **Step 2: Write the failing unit tests**

Create `src/tokenCrypto.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken } from "./tokenCrypto.js";

const KEY = "0f".repeat(32);

test("encrypt/decrypt round-trips a token", () => {
  const enc = encryptToken("ya29.secret-token", KEY);
  assert.match(enc, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(decryptToken(enc, KEY), "ya29.secret-token");
});

test("the same token encrypts differently each time (random IV)", () => {
  assert.notEqual(encryptToken("same", KEY), encryptToken("same", KEY));
});

test("a tampered ciphertext is rejected", () => {
  const [v, iv, tag, ct] = encryptToken("token", KEY).split(":");
  const flipped = Buffer.from(ct, "base64"); flipped[0] ^= 1;
  assert.throws(() => decryptToken([v, iv, tag, flipped.toString("base64")].join(":"), KEY));
});

test("a key that is not 64 hex characters is refused", () => {
  assert.throws(() => encryptToken("token", "short"));
  assert.throws(() => decryptToken(encryptToken("token", KEY), "zz".repeat(32)));
});
```

Create `src/ghlWebhook.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGhlSignature, parseWebhook } from "./ghlWebhook.js";
import { signTestWebhook } from "../scripts/fixtures/ghl-test-webhook-key.mjs";

const body = JSON.stringify({ type: "OutboundMessage", locationId: "loc1", webhookId: "w1" });

test("a body signed with the test key verifies when the test key is allowed", () => {
  assert.equal(verifyGhlSignature(body, signTestWebhook(body), { allowTestKey: true }), true);
});

test("the test key is refused when not allowed (production)", () => {
  assert.equal(verifyGhlSignature(body, signTestWebhook(body), { allowTestKey: false }), false);
});

test("a changed body fails verification", () => {
  const sig = signTestWebhook(body);
  assert.equal(verifyGhlSignature(body.replace("loc1", "loc2"), sig, { allowTestKey: true }), false);
});

test("a missing or garbage signature fails verification", () => {
  assert.equal(verifyGhlSignature(body, undefined, { allowTestKey: true }), false);
  assert.equal(verifyGhlSignature(body, "", { allowTestKey: true }), false);
  assert.equal(verifyGhlSignature(body, "not-a-signature", { allowTestKey: true }), false);
});

test("GHL's real key rejects a signature it did not make", () => {
  assert.equal(verifyGhlSignature(body, Buffer.alloc(64, 7).toString("base64")), false);
});

test("an outbound message becomes activity with its own timestamp", () => {
  const ev = parseWebhook({
    type: "OutboundMessage", locationId: "loc1", webhookId: "w1", userId: "u1",
    messageType: "SMS", source: "app", dateAdded: "2026-09-29T08:15:30.000Z", body: "hello",
  }, 999);
  assert.deepEqual(ev, {
    event: "activity", locationId: "loc1", webhookId: "w1", userId: "u1",
    kind: "message", messageType: "SMS", source: "app", occurredAt: Date.UTC(2026, 8, 29, 8, 15, 30) / 1000,
  });
  assert.equal("body" in ev, false, "message content must never be carried forward");
});

test("calls and internal comments get their own kind", () => {
  assert.equal(parseWebhook({ type: "OutboundMessage", messageType: "CALL" }, 1).kind, "call");
  assert.equal(parseWebhook({ type: "OutboundMessage", messageType: "TYPE_CALL" }, 1).kind, "call");
  assert.equal(parseWebhook({ type: "OutboundMessage", messageType: "InternalComment" }, 1).kind, "comment");
});

test("a missing or bad date falls back to the arrival time; a missing user stays null", () => {
  const ev = parseWebhook({ type: "OutboundMessage", locationId: "loc1", dateAdded: "nope" }, 1234);
  assert.equal(ev.occurredAt, 1234);
  assert.equal(ev.userId, null);
  assert.equal(ev.webhookId, null);
});

test("install and uninstall events are recognised", () => {
  assert.deepEqual(parseWebhook({ type: "INSTALL", locationId: "loc1", companyId: "c1", webhookId: "w9" }, 1),
    { event: "install", locationId: "loc1", companyId: "c1", webhookId: "w9" });
  assert.equal(parseWebhook({ type: "UNINSTALL", locationId: "loc1" }, 1).event, "uninstall");
});

test("any other event type is ignored", () => {
  assert.deepEqual(parseWebhook({ type: "ContactCreate", locationId: "loc1", webhookId: "w2" }, 1),
    { event: "ignored", locationId: "loc1", webhookId: "w2" });
});
```

In `package.json`, replace

```json
    "test:unit": "node --test src/tz.test.mjs"
```

with

```json
    "test:unit": "node --test src/tz.test.mjs src/tokenCrypto.test.mjs src/ghlWebhook.test.mjs"
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module './tokenCrypto.js'` / `'./ghlWebhook.js'`; the 15 tz tests still pass.

- [ ] **Step 4: Implement**

Create `src/tokenCrypto.js`:

```js
/* AES-256-GCM for OAuth tokens at rest. Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function keyFrom(hex) {
  if (!/^[0-9a-f]{64}$/i.test(String(hex ?? ""))) throw new Error("TOKEN_ENC_KEY must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

export function encryptToken(plain, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyHex), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptToken(enc, keyHex) {
  const key = keyFrom(keyHex);
  const [version, iv, tag, ct] = String(enc).split(":");
  if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("unrecognised token format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
```

Create `src/ghlWebhook.js`:

```js
/* GHL webhook authentication (X-GHL-Signature, Ed25519) and payload parsing. */
import { createPublicKey, verify } from "node:crypto";

// GHL's published Ed25519 public key (SPKI DER, base64) for X-GHL-Signature.
export const GHL_WEBHOOK_PUBLIC_KEY = "MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=";
// Public half of scripts/fixtures/ghl-test-webhook-key.mjs. Accepted only outside production.
export const TEST_WEBHOOK_PUBLIC_KEY = "MCowBQYDK2VwAyEAQYyBeyYgpp08Cdxk+4wYHJIuKcsJcKGuTOE3xHhNbmg=";

const keys = new Map();
function publicKey(b64) {
  if (!keys.has(b64)) keys.set(b64, createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" }));
  return keys.get(b64);
}

/** True when `signature` (base64) is a valid Ed25519 signature of the exact raw body. */
export function verifyGhlSignature(rawBody, signature, { allowTestKey = false } = {}) {
  if (typeof signature !== "string" || !signature) return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  const body = Buffer.from(String(rawBody), "utf8");
  const candidates = allowTestKey ? [GHL_WEBHOOK_PUBLIC_KEY, TEST_WEBHOOK_PUBLIC_KEY] : [GHL_WEBHOOK_PUBLIC_KEY];
  return candidates.some((k) => {
    try { return verify(null, body, publicKey(k), sig); } catch { return false; }
  });
}

function kindOf(messageType) {
  const t = String(messageType ?? "");
  if (/call/i.test(t)) return "call";
  if (/comment/i.test(t)) return "comment";
  return "message";
}

/**
 * Reduce a webhook payload to the metadata we keep. Message/call content is never
 * copied out of the payload. `receivedAt` (UNIX seconds) is used when the event has no
 * usable `dateAdded`.
 */
export function parseWebhook(payload, receivedAt) {
  const type = payload?.type;
  const locationId = payload?.locationId ?? null;
  const webhookId = payload?.webhookId ?? null;
  if (type === "INSTALL" || type === "UNINSTALL") {
    return { event: type === "INSTALL" ? "install" : "uninstall", locationId, companyId: payload?.companyId ?? null, webhookId };
  }
  if (type === "OutboundMessage") {
    const at = Date.parse(payload?.dateAdded ?? "");
    return {
      event: "activity",
      locationId,
      webhookId,
      userId: payload?.userId ?? null,
      kind: kindOf(payload?.messageType),
      messageType: payload?.messageType ?? null,
      source: payload?.source ?? null,
      occurredAt: Number.isFinite(at) ? Math.floor(at / 1000) : receivedAt,
    };
  }
  return { event: "ignored", locationId, webhookId };
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npm run test:unit`
Expected: **29 passed, 0 failed** (15 tz + 4 tokenCrypto + 10 ghlWebhook).

- [ ] **Step 6: Commit**

```bash
git add src/ghlWebhook.js src/ghlWebhook.test.mjs src/tokenCrypto.js src/tokenCrypto.test.mjs scripts/fixtures/ghl-test-webhook-key.mjs package.json
git commit -m "feat(activity): GHL webhook signature check, payload parsing and token encryption"
```

---

### Task 3: The webhook endpoint and the 90-day retention

**Files:**
- Modify: `src/server.js` (imports, new `POST /ghl/webhook`, `purgeOldActivity`, `/admin/ghl-connection`, boot timer), `scripts/smoke-test.mjs`, `PROJECT.md`, `docs/superpowers/specs/2026-09-29-activity-monitoring-design.md`

**Interfaces:**
- Consumes (Task 1): tables and `GET /admin/ghl-connection`; smoke `AWLOC`, `AWM`, `awPolicy`, `cleanupLocation(AWLOC)`. (Task 2): `verifyGhlSignature`, `parseWebhook`, `signTestWebhook`.
- Produces: `POST /ghl/webhook` → `200 { ok: true }` for every correctly signed request (stored or ignored), `401 { error: "WEBHOOK_BAD_SIGNATURE" }` otherwise, `413 PAYLOAD_TOO_LARGE` over 256 KB. `purgeOldActivity()` in `src/server.js`.

- [ ] **Step 1: Write the failing smoke checks**

At the top of `scripts/smoke-test.mjs`, next to the other imports, add:

```js
import { signTestWebhook } from "./fixtures/ghl-test-webhook-key.mjs";
```

Below the existing `setPolicySince` helper, add:

```js
/** POST a fake GHL webhook; `sign: false` sends no signature, `tamper` changes the body after signing. */
async function ghlWebhook(payload, { sign = true, tamper = false } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (sign) headers["X-GHL-Signature"] = signTestWebhook(raw);
  const r = await fetch(`${BASE}/ghl/webhook`, { method: "POST", headers, body: tamper ? raw.replace(/}$/, ',"x":1}') : raw });
  let body; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

/** Run one query against the local dev DB; null when there is no local DB. */
async function localRows(sql, params) {
  let rows = null;
  const { skipped } = await withLocalDb(async (conn) => { [rows] = await conn.execute(sql, params); });
  return skipped ? null : rows;
}
```

Insert immediately **before** `await cleanupLocation(AWLOC);`:

```js
// Webhooks. Signed with the test key, which the local (non-production) server accepts.
const awMsg = (extra) => ({
  type: "OutboundMessage", locationId: AWLOC, userId: `${AWLOC}-u1`, messageType: "SMS",
  source: "app", dateAdded: new Date().toISOString(), body: "محتوى لا يجب أن يُخزَّن", ...extra,
});
check("an unsigned webhook → 401",
  (await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w0` }), { sign: false })).body?.error === "WEBHOOK_BAD_SIGNATURE");
check("a webhook whose body changed after signing → 401",
  (await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w0` }), { tamper: true })).status === 401);

const awInstall = await ghlWebhook({ type: "INSTALL", locationId: AWLOC, companyId: "comp-1", webhookId: `${AWLOC}-install` });
const awConn1 = await call(AWM, "GET", "/admin/ghl-connection");
check("a signed install marks the location connected and records the event time",
  awInstall.status === 200 && awConn1.body?.installed === true && typeof awConn1.body?.last_event_at === "number",
  `(${awInstall.status} ${JSON.stringify(awConn1.body)})`);

await awPolicy({ activity_monitoring: false });
await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w1` }));
check("activity is not stored while monitoring is off",
  (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h === 0);

await awPolicy({ activity_monitoring: true });
const awStored = await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w2` }));
check("activity is stored once monitoring is on",
  awStored.status === 200 && (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h === 1);
await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w2` }));
check("a retried webhook (same webhookId) is stored once",
  (await call(AWM, "GET", "/admin/ghl-connection")).body?.events_24h === 1);

await ghlWebhook(awMsg({ webhookId: `${AWLOC}-w3`, messageType: "CALL" }));
const awRows = await localRows(
  "SELECT * FROM activity_events WHERE location_id = :loc ORDER BY webhook_id",
  { loc: AWLOC });
if (awRows) {
  // Ordered by webhook_id (w2 then w3); ORDER BY an ENUM would sort by declaration order.
  check("stored activity keeps kind, type and source — and no content column exists",
    awRows.length === 2 && awRows[0].kind === "message" && awRows[1].kind === "call"
      && awRows[0].message_type === "SMS" && awRows[0].source === "app"
      && awRows[0].user_id === `${AWLOC}-u1` && !("body" in awRows[0]),
    `(${JSON.stringify(awRows)})`);
  await localRows(
    `INSERT INTO activity_events (id, location_id, user_id, occurred_at, kind, webhook_id, created_at)
     VALUES (UUID(), :loc, :uid, :old, 'message', :wid, :old)`,
    { loc: AWLOC, uid: `${AWLOC}-u1`, old: Math.floor(Date.now() / 1000) - 91 * 86400, wid: `${AWLOC}-old` });
  await call(AWM, "GET", "/admin/ghl-connection");
  const awOld = await localRows("SELECT COUNT(*) AS n FROM activity_events WHERE webhook_id = :wid", { wid: `${AWLOC}-old` });
  check("activity older than 90 days is purged", Number(awOld?.[0]?.n) === 0, `(${JSON.stringify(awOld)})`);
} else {
  console.log("  SKIP  stored-activity and retention checks (need a local DB)");
}

await ghlWebhook({ type: "UNINSTALL", locationId: AWLOC, webhookId: `${AWLOC}-uninstall` });
check("a signed uninstall marks the location disconnected",
  (await call(AWM, "GET", "/admin/ghl-connection")).body?.installed === false);
```

- [ ] **Step 2: Run to verify they fail**

Run the smoke command. Expected: the new webhook checks FAIL (the route does not exist, so the SPA fallback answers); the 102 earlier checks PASS.

- [ ] **Step 3: Implement the route and retention**

In `src/server.js`, add after the `./tz.js` import:

```js
import { verifyGhlSignature, parseWebhook } from "./ghlWebhook.js";
```

Insert immediately **before** the `/* ---------- Static SPA` comment:

```js
/* ---------- GHL (called by GHL, not by a signed-in user) ---------- */

const ACTIVITY_RETENTION_SEC = 90 * 86400;
const WEBHOOK_MAX_BYTES = 256 * 1024;

/** Raw activity rows are metadata kept for 90 days; summaries and alerts stay (spec §4). */
async function purgeOldActivity() {
  await q("DELETE FROM activity_events WHERE occurred_at < :cutoff", { cutoff: now() - ACTIVITY_RETENTION_SEC });
}

app.post("/ghl/webhook", async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > WEBHOOK_MAX_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE");
  // The signature is the only authentication this route has. The test key is honoured
  // only outside production, like dev-login.
  const allowTestKey = env.NODE_ENV !== "production";
  if (!verifyGhlSignature(raw, c.req.header("x-ghl-signature"), { allowTestKey })) {
    throw new HttpError(401, "WEBHOOK_BAD_SIGNATURE");
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return c.json({ ok: true }); }
  const t = now();
  const ev = parseWebhook(payload, t);
  // Always acknowledge a signed event, stored or not, so GHL does not retry it.
  if (!ev.locationId) return c.json({ ok: true });

  if (ev.event === "install" || ev.event === "uninstall") {
    const installed = ev.event === "install";
    await q(
      `INSERT INTO ghl_installs (location_id, company_id, installed_at, uninstalled_at, last_event_at, updated_at)
       VALUES (:loc, :company, :installedAt, :uninstalledAt, :t, :t)
       ON DUPLICATE KEY UPDATE company_id = COALESCE(VALUES(company_id), company_id),
                               installed_at = COALESCE(VALUES(installed_at), installed_at),
                               uninstalled_at = VALUES(uninstalled_at),
                               last_event_at = VALUES(last_event_at), updated_at = VALUES(updated_at)`,
      { loc: ev.locationId, company: ev.companyId, installedAt: installed ? t : null, uninstalledAt: installed ? null : t, t }
    );
    return c.json({ ok: true });
  }

  // Any other signed event for this location proves events are arriving.
  await q(
    `INSERT INTO ghl_installs (location_id, last_event_at, updated_at) VALUES (:loc, :t, :t)
     ON DUPLICATE KEY UPDATE last_event_at = VALUES(last_event_at), updated_at = VALUES(updated_at)`,
    { loc: ev.locationId, t }
  );

  if (ev.event === "activity") {
    const [st] = await q("SELECT activity_monitoring FROM settings WHERE location_id = :loc", { loc: ev.locationId });
    if (st?.activity_monitoring) {
      // GHL retries a failed delivery up to 12 times; webhook_id makes the insert idempotent.
      const webhookId = ev.webhookId ?? createHash("sha256").update(raw).digest("hex");
      await q(
        `INSERT IGNORE INTO activity_events
           (id, location_id, user_id, occurred_at, kind, message_type, source, webhook_id, created_at)
         VALUES (:id, :loc, :uid, :at, :kind, :messageType, :source, :webhookId, :t)`,
        {
          id: randomUUID(), loc: ev.locationId, uid: ev.userId, at: ev.occurredAt, kind: ev.kind,
          messageType: ev.messageType == null ? null : String(ev.messageType).slice(0, 40),
          source: ev.source == null ? null : String(ev.source).slice(0, 60),
          webhookId: String(webhookId).slice(0, 100), t,
        }
      );
    }
  }
  return c.json({ ok: true });
});

```

In `GET /admin/ghl-connection` (Task 1), make the first statement of the handler body:

```js
  await purgeOldActivity();
```

In the Boot section, replace

```js
setInterval(() => autoCloseStale().catch((e) => console.error("[auto-close]", e)), AUTO_CLOSE_EVERY_MS);
```

with

```js
setInterval(() => autoCloseStale().catch((e) => console.error("[auto-close]", e)), AUTO_CLOSE_EVERY_MS);
setInterval(() => purgeOldActivity().catch((e) => console.error("[activity-retention]", e)), AUTO_CLOSE_EVERY_MS);
```

- [ ] **Step 4: Restart and run the smoke test**

Expected: **111 passed, 0 failed** (102 + 9), or **109 passed** plus one `SKIP` line when there is no local DB. `npm run test:unit` stays at 29.

- [ ] **Step 5: Document**

`PROJECT.md` §8: add a new subsection "### من GHL (مش من مستخدم)":

```markdown
| Method | Path | الوصف |
|---|---|---|
| POST | `/ghl/webhook` | أحداث GHL. التحقق **بس** بالتوقيع `X-GHL-Signature` (Ed25519، المفتاح العام تبع GHL). توقيع غلط → `401 WEBHOOK_BAD_SIGNATURE`. أي حدث موقّع صح بيرجع `200` (انخزّن أو انتجاهل) لحتى GHL ما يعيد الإرسال. `INSTALL`/`UNINSTALL` بيحدّثوا `ghl_installs`؛ `OutboundMessage` بينخزّن كـ `activity_events` (بيانات وصفية بس) إذا `activity_monitoring = 1`، ومرة وحدة لكل `webhookId`. أكبر من 256KB → `413 PAYLOAD_TOO_LARGE` |
```

Append to رموز الأخطاء:

```markdown
| `WEBHOOK_BAD_SIGNATURE` | 401 | حدث بدون توقيع GHL صحيح | — (مش للواجهة) |
| `PAYLOAD_TOO_LARGE` | 413 | جسم الحدث أكبر من 256KB | — (مش للواجهة) |
```

In the spec, apply the refinements listed at the top of this plan: in §4.1 `activity_events` make `user_id` "NULL allowed" and add `message_type VARCHAR(40) NULL`, `source VARCHAR(60) NULL`; in §5.1 replace step 3 with "`OutboundMessage` for a location with `activity_monitoring = 1` → `INSERT IGNORE` (metadata only, `user_id` may be NULL). Phase B decides which rows count (known employees, not automated)." and change the last line to "Unsigned requests never write anything; correctly signed install/uninstall events are recorded for any location."; in §5.7 add "also run lazily on `GET /admin/ghl-connection`"; in §7 add `INVALID_ACTIVITY_MONITORING` (400).

- [ ] **Step 6: Commit**

```bash
git add src/server.js scripts/smoke-test.mjs PROJECT.md docs/superpowers/specs/2026-09-29-activity-monitoring-design.md
git commit -m "feat(activity): signed GHL webhook endpoint and 90-day activity retention"
```

---

### Task 4: OAuth install callback

**Files:**
- Create: `src/ghlOAuth.js`, `src/ghlOAuth.test.mjs`
- Modify: `src/server.js`, `package.json`, `scripts/smoke-test.mjs`, `PROJECT.md`

**Interfaces:**
- Consumes (Task 2): `encryptToken`. (Task 1): `ghl_installs`, `ACTIVITY_SCOPE`.
- Produces: `exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl?, tokenUrl? }) → { accessToken, refreshToken, expiresIn, scopes, locationId, companyId }` (throws `Error("OAUTH_EXCHANGE_FAILED")`); `GET /ghl/oauth/callback?code=` → Arabic HTML page: `200` on success, `400` without a code, `503` when the server is not configured, `502` when GHL refuses the code.

- [ ] **Step 1: Write the failing unit tests**

Create `src/ghlOAuth.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { exchangeCode, GHL_TOKEN_URL } from "./ghlOAuth.js";

const args = { code: "abc", clientId: "cid", clientSecret: "secret", redirectUri: "https://timeclock.noursky.com/ghl/oauth/callback" };
const fakeFetch = (status, json, seen) => async (url, init) => {
  seen?.push({ url, init });
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

test("posts the authorization code as a form to GHL's token endpoint", async () => {
  const seen = [];
  await exchangeCode({ ...args, fetchImpl: fakeFetch(200, { access_token: "a", refresh_token: "r", expires_in: 86399, scope: "x", locationId: "loc1", companyId: "c1" }, seen) });
  assert.equal(seen[0].url, GHL_TOKEN_URL);
  assert.equal(seen[0].init.method, "POST");
  const form = new URLSearchParams(String(seen[0].init.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "abc");
  assert.equal(form.get("client_id"), "cid");
  assert.equal(form.get("client_secret"), "secret");
  assert.equal(form.get("redirect_uri"), args.redirectUri);
  assert.equal(form.get("user_type"), "Location");
});

test("maps a successful response", async () => {
  const out = await exchangeCode({ ...args, fetchImpl: fakeFetch(200, {
    access_token: "acc", refresh_token: "ref", expires_in: 86399,
    scope: "conversations/message.readonly", locationId: "loc1", companyId: "c1",
  }) });
  assert.deepEqual(out, {
    accessToken: "acc", refreshToken: "ref", expiresIn: 86399,
    scopes: "conversations/message.readonly", locationId: "loc1", companyId: "c1",
  });
});

test("a refused code throws OAUTH_EXCHANGE_FAILED", async () => {
  await assert.rejects(exchangeCode({ ...args, fetchImpl: fakeFetch(400, { error: "invalid_grant" }) }), /OAUTH_EXCHANGE_FAILED/);
});

test("a token without a location throws (agency-level installs are not supported)", async () => {
  await assert.rejects(exchangeCode({ ...args, fetchImpl: fakeFetch(200, { access_token: "a", companyId: "c1" }) }), /OAUTH_EXCHANGE_FAILED/);
});
```

In `package.json`, replace

```json
    "test:unit": "node --test src/tz.test.mjs src/tokenCrypto.test.mjs src/ghlWebhook.test.mjs"
```

with

```json
    "test:unit": "node --test src/tz.test.mjs src/tokenCrypto.test.mjs src/ghlWebhook.test.mjs src/ghlOAuth.test.mjs"
```

- [ ] **Step 2: Write the failing smoke checks**

In `scripts/smoke-test.mjs`, insert immediately **before** `await cleanupLocation(AWLOC);`:

```js
// OAuth callback. The local .env has no GHL_CLIENT_ID, so a code cannot be exchanged here.
const awNoCode = await fetch(`${BASE}/ghl/oauth/callback`);
check("the OAuth callback without a code shows an error page",
  awNoCode.status === 400 && (await awNoCode.text()).includes("أعد تثبيت التطبيق"));
const awNotConfigured = await fetch(`${BASE}/ghl/oauth/callback?code=test-code`);
check("the OAuth callback explains when the server is not configured",
  awNotConfigured.status === 503 && (await awNotConfigured.text()).includes("غير مُعدّ"));
```

- [ ] **Step 3: Run to verify they fail**

Run `npm run test:unit` (Expected: `Cannot find module './ghlOAuth.js'`) and the smoke command (Expected: the 2 new checks FAIL; 111 earlier PASS).

- [ ] **Step 4: Implement**

Create `src/ghlOAuth.js`:

```js
/* GHL Marketplace OAuth: exchange the install code for a location token. */
export const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch, tokenUrl = GHL_TOKEN_URL }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    user_type: "Location",
  });
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || !data?.access_token || !data?.locationId) {
    const err = new Error("OAUTH_EXCHANGE_FAILED");
    err.status = res.status;
    throw err;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: Number(data.expires_in) || 0,
    scopes: data.scope ?? "",
    locationId: data.locationId,
    companyId: data.companyId ?? null,
  };
}
```

In `src/server.js`, add after the `./ghlWebhook.js` import:

```js
import { exchangeCode } from "./ghlOAuth.js";
import { encryptToken } from "./tokenCrypto.js";
```

Insert immediately **after** the whole `app.post("/ghl/webhook", …)` handler:

```js
const DEFAULT_REDIRECT_URI = "https://timeclock.noursky.com/ghl/oauth/callback";

// A tiny self-contained Arabic page; the texts are fixed strings, never request data.
function installPage(title, message) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#F7F6FB;color:#1D1B2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:460px;background:#fff;border:1px solid #E3E0F0;border-radius:14px;padding:28px}h1{color:#6C5CE7;font-size:20px;margin:0 0 10px}p{margin:0;line-height:1.8}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

app.get("/ghl/oauth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.html(installPage("تعذّر التثبيت", "الرابط ناقص. أعد تثبيت التطبيق من الـ Marketplace."), 400);
  }
  if (!env.GHL_CLIENT_ID || !env.GHL_CLIENT_SECRET || !env.TOKEN_ENC_KEY) {
    return c.html(installPage("تعذّر التثبيت", "الربط مع GHL غير مُعدّ على السيرفر بعد. تواصل مع NourSky."), 503);
  }
  let tok;
  try {
    tok = await exchangeCode({
      code, clientId: env.GHL_CLIENT_ID, clientSecret: env.GHL_CLIENT_SECRET,
      redirectUri: env.GHL_REDIRECT_URI || DEFAULT_REDIRECT_URI,
    });
  } catch (e) {
    console.error("[oauth]", e.message, e.status ?? "");
    return c.html(installPage("تعذّر التثبيت", "GHL رفض طلب الربط. أعد تثبيت التطبيق من الـ Marketplace."), 502);
  }
  const t = now();
  await q(
    `INSERT INTO ghl_installs (location_id, company_id, access_token_enc, refresh_token_enc, token_expires_at,
                               scopes, installed_at, uninstalled_at, updated_at)
     VALUES (:loc, :company, :access, :refresh, :expiresAt, :scopes, :t, NULL, :t)
     ON DUPLICATE KEY UPDATE company_id = VALUES(company_id), access_token_enc = VALUES(access_token_enc),
                             refresh_token_enc = VALUES(refresh_token_enc), token_expires_at = VALUES(token_expires_at),
                             scopes = VALUES(scopes), installed_at = VALUES(installed_at),
                             uninstalled_at = NULL, updated_at = VALUES(updated_at)`,
    {
      loc: tok.locationId, company: tok.companyId,
      access: encryptToken(tok.accessToken, env.TOKEN_ENC_KEY),
      refresh: tok.refreshToken ? encryptToken(tok.refreshToken, env.TOKEN_ENC_KEY) : null,
      expiresAt: t + tok.expiresIn, scopes: String(tok.scopes).slice(0, 1000), t,
    }
  );
  return c.html(installPage("تم الربط", "تم ربط TimeClock بحسابك. بتقدر تسكّر هالصفحة وترجع لـ GHL."));
});

```

- [ ] **Step 5: Run to verify they pass**

`npm run test:unit` → **33 passed** (29 + 4). Restart the API; smoke → **113 passed, 0 failed** (or 111 + SKIP without a local DB).

- [ ] **Step 6: Document in `PROJECT.md`**

In the "من GHL" subsection add:

```markdown
| GET | `/ghl/oauth/callback?code=` | رابط الرجوع بعد تثبيت التطبيق. بيبدّل الكود بتوكن من `services.leadconnectorhq.com/oauth/token` وبيخزّنه **مشفّر** (AES-256-GCM بـ `TOKEN_ENC_KEY`) بـ `ghl_installs`. بيرجّع صفحة عربية: `200` نجاح، `400` بدون كود، `503` السيرفر مش مُعدّ، `502` GHL رفض الكود |
```

In §14 (النشر) add the optional env vars `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET` (من إعدادات التطبيق بالـ Marketplace)، `TOKEN_ENC_KEY` (64 حرف hex عشوائي، مثلاً `openssl rand -hex 32`)، و `GHL_REDIRECT_URI` (اختياري، الافتراضي `https://timeclock.noursky.com/ghl/oauth/callback`). Also add the same four names to `CLAUDE.md`'s environment-variable list as optional.

- [ ] **Step 7: Commit**

```bash
git add src/ghlOAuth.js src/ghlOAuth.test.mjs src/server.js package.json scripts/smoke-test.mjs PROJECT.md CLAUDE.md
git commit -m "feat(activity): OAuth install callback with encrypted token storage"
```

---

### Task 5: Settings screen — monitoring toggle, idle threshold, connection status

**Files:**
- Modify: `web/src/components/SettingsPanel.jsx`, `web/src/components/SettingsPanel.test.jsx`

**Interfaces:**
- Consumes (Tasks 1, 3): `GET/PUT /admin/settings` with `activity_monitoring`, `idle_minutes`; `GET /admin/ghl-connection` → `{ installed, has_activity_scope, last_event_at, events_24h }`; errors `INVALID_IDLE_MINUTES`, `INVALID_ACTIVITY_MONITORING`. `formatStamp(ts, timeZone)` from `web/src/time.js`.
- Produces: checkbox labelled `مراقبة النشاط` (id `activity-monitoring`), number input labelled `حد الخمول (دقائق)` (id `idle-minutes`, shown only while monitoring is on), a status line inside an element with `role="status"` and `aria-label="حالة الربط مع GHL"`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("SettingsPanel", …)` in `web/src/components/SettingsPanel.test.jsx`:

```jsx
  const AW = { timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00", late_grace_minutes: 15, note_on_stop: "off", break_mode: "off", activity_monitoring: false, idle_minutes: 30 };
  const awApi = (settings, connection, put = vi.fn(async (_p, body) => ({ ...settings, ...body }))) => ({
    get: vi.fn(async (path) => (path === "/admin/ghl-connection" ? connection : settings)),
    put,
  });

  it("saves the activity monitoring toggle and idle threshold", async () => {
    const api = awApi(AW, { installed: true, has_activity_scope: true, last_event_at: null, events_24h: 0 });
    wrap(<SettingsPanel api={api} />);
    fireEvent.click(await screen.findByLabelText("مراقبة النشاط"));
    fireEvent.change(screen.getByLabelText("حد الخمول (دقائق)"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put.mock.calls[0][1]).toEqual(expect.objectContaining({ activity_monitoring: true, idle_minutes: 45 }));
  });

  it("hides the idle threshold while monitoring is off", async () => {
    wrap(<SettingsPanel api={awApi(AW, { installed: false, has_activity_scope: false, last_event_at: null, events_24h: 0 })} />);
    expect(await screen.findByLabelText("مراقبة النشاط")).not.toBeChecked();
    expect(screen.queryByLabelText("حد الخمول (دقائق)")).not.toBeInTheDocument();
  });

  it("shows a working connection with the last event time and the 24h count", async () => {
    const last = Date.UTC(2026, 8, 29, 8, 42) / 1000; // 11:42 in Riyadh
    wrap(<SettingsPanel api={awApi({ ...AW, activity_monitoring: true }, { installed: true, has_activity_scope: true, last_event_at: last, events_24h: 17 })} />);
    const status = await screen.findByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("مربوط"));
    expect(status.textContent).toContain("11:42");
    expect(status.textContent).toContain("17");
    expect(status.textContent).not.toContain("غير مربوط");
  });

  it("tells the manager to reinstall when the activity scope is missing", async () => {
    wrap(<SettingsPanel api={awApi(AW, { installed: true, has_activity_scope: false, last_event_at: null, events_24h: 0 })} />);
    const status = await screen.findByRole("status", { name: "حالة الربط مع GHL" });
    await waitFor(() => expect(status.textContent).toContain("غير مربوط"));
    expect(status.textContent).toContain("أعد تثبيت التطبيق");
  });

  it("explains an idle threshold out of range", async () => {
    const put = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "INVALID_IDLE_MINUTES" }); });
    wrap(<SettingsPanel api={awApi({ ...AW, activity_monitoring: true, idle_minutes: 5 }, { installed: true, has_activity_scope: true, last_event_at: null, events_24h: 0 }, put)} />);
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    expect(await screen.findByText("حد الخمول لازم يكون بين 10 و240 دقيقة")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && npx vitest run src/components/SettingsPanel.test.jsx`
Expected: the 5 new tests FAIL (no `مراقبة النشاط` label / no status); the 7 older tests PASS.

- [ ] **Step 3: Implement**

In `web/src/components/SettingsPanel.jsx`:

Add the import:

```js
import { formatStamp } from "../time.js";
```

Replace

```js
  const [error, setError] = useState("");
```

with

```js
  const [error, setError] = useState("");
  const [conn, setConn] = useState(null);
  const [connFailed, setConnFailed] = useState(false);
```

Replace

```js
  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => setError("حدث خطأ، حاول مرة أخرى")); }, []);
```

with

```js
  useEffect(() => { api.get("/admin/settings").then(setS).catch(() => setError("حدث خطأ، حاول مرة أخرى")); }, []);
  // The connection status is informative only; a failure never blocks the settings form.
  useEffect(() => { api.get("/admin/ghl-connection").then(setConn).catch(() => setConnFailed(true)); }, []);
```

In the PUT body, after `note_on_stop: s.note_on_stop ?? "off",` add:

```js
        activity_monitoring: Boolean(s.activity_monitoring),
        // Same empty-field rule as the grace: an emptied field means the default.
        idle_minutes: s.idle_minutes === "" || s.idle_minutes == null ? 30 : Number(s.idle_minutes),
```

In the error mapping, after the `INVALID_BREAK_WINDOW` line add:

```js
        : e.code === "INVALID_IDLE_MINUTES" ? "حد الخمول لازم يكون بين 10 و240 دقيقة"
        : e.code === "INVALID_ACTIVITY_MONITORING" ? "إعداد مراقبة النشاط غير صحيح"
```

Add, just before `const set = (k) => …`:

```js
  const connected = Boolean(conn && (conn.last_event_at != null || (conn.installed && conn.has_activity_scope)));
  const connectionText = connFailed || (!conn && s)
    ? (connFailed ? "تعذّر فحص حالة الربط مع GHL" : "جارٍ فحص الربط مع GHL…")
    : connected
      ? `✓ مربوط — ${conn.last_event_at != null
        ? `آخر حدث وصل: ${formatStamp(conn.last_event_at, s.timezone)}`
        : "لسا ما وصل ولا حدث"}${s.activity_monitoring ? ` · وصل ${conn.events_24h} حدث بآخر 24 ساعة` : ""}`
      : "✗ غير مربوط — أعد تثبيت التطبيق من الـ Marketplace لتتفعّل صلاحية النشاط";
```

Insert immediately **before** the `{error && <div className="field">…` line:

```jsx
      <div className="field check">
        <label><input id="activity-monitoring" type="checkbox" checked={Boolean(s.activity_monitoring)} onChange={(e) => setS({ ...s, activity_monitoring: e.target.checked })} />مراقبة النشاط</label>
      </div>
      {s.activity_monitoring && (
        <div className="field">
          <label htmlFor="idle-minutes">حد الخمول (دقائق)</label>
          <input id="idle-minutes" type="number" step="1" min="10" max="240" value={s.idle_minutes ?? 30} onChange={set("idle_minutes")} />
        </div>
      )}
      <div className="field">
        <p className="hint" role="status" aria-label="حالة الربط مع GHL">{connectionText}</p>
        <p className="hint">لازم يكون الموظفين عارفين إنه نشاطهم مراقب.</p>
      </div>
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && npx vitest run`
Expected: **96 passed** (91 + 5).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SettingsPanel.jsx web/src/components/SettingsPanel.test.jsx
git commit -m "feat(settings-ui): activity monitoring toggle, idle threshold and GHL connection status"
```

---

## After all tasks (controller + owner)

1. Full verification: unit 33, frontend 96, smoke 113 (0 failed), `npm run build`.
2. `docs/PROGRESS.md` + `docs/DECISIONS.md`: activity is evidence, not the clock; official webhooks, not audit logs; metadata only, 90-day raw retention; test signing key only outside production.
3. **Owner, before the push:** run `migrations/004_activity_monitoring.sql` in phpMyAdmin; confirm with `SHOW TABLES LIKE 'activity%'; SHOW TABLES LIKE 'ghl_installs';`; record the date in `migrations/README.md`.
4. Push `main`, verify `/health`, the bundle hash, and `POST /ghl/webhook` without a signature → `401` on the live site.
5. **Owner, in the Marketplace app:** add scope `conversations/message.readonly`; webhook URL `https://timeclock.noursky.com/ghl/webhook` subscribed to `OutboundMessage`; redirect URL `https://timeclock.noursky.com/ghl/oauth/callback`; copy Client ID / Secret into Hostinger env with a new `TOKEN_ENC_KEY`; redeploy.
6. **Verification on Innova (the point of phase A):** reinstall the app on Innova and accept the new scope → confirmation page; switch "مراقبة النشاط" on; then send an SMS/WhatsApp, make an outbound call, write an internal comment, send one message from the GHL mobile app, and trigger one workflow message. Owner runs in phpMyAdmin:
   ```sql
   SELECT kind, message_type, source, user_id IS NOT NULL AS has_user, COUNT(*) AS n
     FROM activity_events WHERE location_id = 'i56NLijGxG6EWUlMlUMd'
    GROUP BY kind, message_type, source, has_user;
   ```
   Record which `source` / `userId` pattern marks automated messages and whether mobile messages arrive; update spec §2 before phase B.
