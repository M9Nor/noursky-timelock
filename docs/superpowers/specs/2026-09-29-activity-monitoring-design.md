# NourSky TimeClock — Activity Monitoring (Design Spec)

**Date:** 2026-09-29 · **Status:** approved in brainstorming, not yet implemented
**Owner decision:** activity from GHL is used as **evidence and alerts**, never as the clock.

## 1. Goal

Help managers catch the two failures manual clock-in cannot see on its own:

1. an employee is **working in GHL but never clocked in** (forgot to start);
2. an employee **clocked in but shows no activity** for a long stretch (idle, or forgot to stop).

Manual start/stop stays the record of truth for hours and pay. Activity only raises
alerts, marks sessions for review, and gives the manager one-click corrections that
are logged like any other manager edit. **Nothing is ever deducted automatically.**

### 1.1 Relation to earlier decisions

The attendance-policies spec (2026-09-24, §2 and §9) rejected automatic activity
tracking because it "measures activity, not work" and "its failures are silent and
employer-biased". This design keeps that principle: activity never starts, stops or
shortens a session by itself. It only informs a human (the manager), and the employee
can answer every alert. The owner approved this hybrid on 2026-09-29.

### 1.2 Out of scope

- Field / outside employees as a separate category (owner: not needed; the setting is
  company-wide).
- Any alert channel outside the app (WhatsApp, SMS, email, GHL workflows). Owner
  requirement: **no cost at all**; GHL's Inbound Webhook workflow trigger is a premium
  trigger, so alerts stay inside TimeClock.
- Reading message/call **content**. Only who, when and what kind.
- GHL Audit Logs. There is no public API or OAuth scope for them (verified
  2026-09-29 against the scopes list and the "Audit Logs API Access" feature request);
  the internal endpoint the GHL UI uses is undocumented and is **rejected** for a
  payroll-adjacent system.

## 2. Activity source

**Official GHL webhooks** delivered to our Marketplace app.

- Event used first: **`OutboundMessage`** — carries `userId` for messages, outbound
  calls and internal comments sent by a team member (verified in the webhook docs).
- Other events (tasks, notes, opportunities, appointments) may be added later **only
  after** confirming on a real account that they identify the acting user.
- Automated messages (workflows, bulk actions, campaigns) must **not** count as a
  person's activity. The exact payload field that distinguishes them is verified on
  Innova in phase A before it is relied upon.
- Messages sent from the GHL mobile app arrive the same way and count.

Rejected: polling the GHL API (slower, many calls, rate limits) and the internal
audit-log endpoint (see §1.2).

## 3. GHL app changes (Marketplace, one time)

| Setting | Value |
|---|---|
| Scope added | `conversations/message.readonly` (read-only; no write scope) |
| Webhook URL | `https://timeclock.noursky.com/webhooks/events` · subscribe `OutboundMessage` (+ app install/uninstall events, delivered by default) |
| Redirect URL (OAuth) | `https://timeclock.noursky.com/oauth/callback` |

Each client Sub-Account must **reinstall once** and accept the new scope. Until then the
account works exactly as today.

New Hostinger environment variables (names only; values never in the repo):
`GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `TOKEN_ENC_KEY` (32-byte key for token encryption),
`GHL_APP_ID` (our app's id, to ignore other apps' install/uninstall events; set in production).

## 4. Data model (migration `004`)

### 4.1 New tables

**`ghl_installs`** — one row per location that installed the app with OAuth.
`location_id` (PK), `company_id`, `access_token_enc`, `refresh_token_enc`,
`token_expires_at`, `scopes`, `installed_at`, `uninstalled_at` (NULL while installed),
`last_event_at` (last webhook received for this location), `updated_at`.
Tokens are encrypted with AES-256-GCM using `TOKEN_ENC_KEY`. They are stored to
complete the install correctly and for future features; **no refresh job is built now**
because this feature never calls the GHL API (webhooks do not need a token).

**`activity_events`** — one row per counted action.
`id`, `location_id`, `user_id` (NULL allowed), `occurred_at` (UNIX seconds, from the event payload,
not arrival time), `kind` ENUM('message','call','comment','other'),
`message_type` VARCHAR(40) NULL, `source` VARCHAR(60) NULL,
`webhook_id` (UNIQUE dedupe key — GHL retries up to 12 times; holds `m:<messageId>` when the payload has a message id, else the `webhookId`, else a hash of the raw body), `created_at`.
Index `(location_id, user_id, occurred_at)` and `(occurred_at)` for retention.
**Retention: rows older than 90 days are deleted every 15 minutes (timer) and lazily on `GET /admin/ghl-connection`.**

**`activity_alerts`** — alerts and their review trail. Kept forever.
`id`, `location_id`, `user_id`, `session_id` (NULL for not-clocked-in),
`kind` ENUM('idle','working_not_clocked_in'),
`from_at` (idle: last activity; not-clocked-in: first activity),
`to_at` (idle: when activity resumed, NULL while still idle),
`detected_at`, `status` ENUM('open','resolved','dismissed'),
`resolution` ENUM('dismissed','ended_at_last_activity','clocked_in','late_activity') NULL,
`resolved_by` (user id or `system`), `resolved_at`,
`employee_note` VARCHAR(300) NULL, `employee_note_at`.
Uniqueness, enforced in SQL (generated-column + UNIQUE, same pattern as `open_flag`):
at most one **ongoing** idle stretch per session (`kind = 'idle' AND to_at IS NULL AND
status = 'open'`) — a session can collect several idle alerts over a day, one per stretch;
and at most one **open** not-clocked-in alert per employee at a time (a new one can open
after the previous is resolved, e.g. the employee stops and later works again unclocked).

### 4.2 Changed tables

`settings`:
- `activity_monitoring` TINYINT(1) NOT NULL DEFAULT 0 — off by default everywhere.
- `idle_minutes` INT NOT NULL DEFAULT 30 — allowed 10–240.
- `activity_monitoring_since` BIGINT NULL — set when monitoring is switched on; idle is
  never measured from before it.

`sessions` (the per-session summary, kept forever):
- `activity_count` INT NULL
- `last_activity_at` BIGINT NULL
- `longest_idle_sec` INT NULL

NULL means "not monitored during this session" and is shown as "—", never as zero.

## 5. Server behaviour

### 5.1 `POST /webhooks/events`
1. Read the raw body (max 256 KB, else `413 PAYLOAD_TOO_LARGE`); verify `X-GHL-Signature`
   (Ed25519, GHL public key). Invalid → `401`, nothing stored (one content-free warning line
   per minute at most is logged). **A valid signature proves the event came from GHL, not that
   it is meant for our app:** GHL signs every Marketplace app's webhooks with the same key, so
   another app installed on the same location could have its signed events reach us. (The legacy `X-WH-Signature` RSA header is deprecated by GHL
   on 2026-09-01 and is not supported.)
2. Install / uninstall events → upsert `ghl_installs`, but only when the payload's `appId`
   equals our `GHL_APP_ID`; another app's (or a missing) `appId` is acknowledged with `200`
   and writes nothing. With `GHL_APP_ID` unset the check is off — set it in production.
3. `OutboundMessage` for a location with `activity_monitoring = 1` → `INSERT IGNORE`
   (metadata only, `user_id` may be NULL). Phase B decides which rows count (known
   employees, not automated). The same message redelivered through another app carries a new
   `webhookId`, so the dedupe key is `m:<messageId>` when present, else `webhookId`, else the
   SHA-256 of the raw body.
4. For any other signed event with a `locationId`, upsert the `ghl_installs` row and update
   its `last_event_at` (a row is created if the location was not known yet).
5. Respond `200` quickly for any valid, signed event (including ignored ones), so GHL
   does not retry.

Unsigned requests never write anything. Correctly signed install/uninstall events are recorded for any location, provided they carry our `appId` (when `GHL_APP_ID` is set): the signature proves the event is from GHL, not that it is for our app.

### 5.2 `GET /oauth/callback?code=`
Exchange the code at `https://services.leadconnectorhq.com/oauth/token`
(`authorization_code`), store encrypted tokens in `ghl_installs`, render a short Arabic
confirmation page. A failed exchange shows an Arabic error page and stores nothing.

### 5.3 Detector
Runs on its own **60-second timer** and lazily before manager reads
(`/admin/live`, `/admin/alerts`). Only for locations with monitoring on **and** at least
one webhook received in the last 24 hours (so a GHL outage never turns into idle alerts).

- **Idle:** for each open session, last activity = the latest of
  `session.started_at`, `activity_monitoring_since`, and the employee's last
  `activity_events.occurred_at` in the session. Clocking in counts as activity.
  If `now − last activity > idle_minutes × 60` and the employee is **not** on an
  employee break or inside a fixed break window → open an `idle` alert
  (`from_at` = last activity).
- **Idle resumes:** when a later event arrives for that session, set `to_at` on the
  open idle alert. The alert stays open for the manager.
- **Late event:** if an event arrives whose `occurred_at` falls inside an alert's
  idle gap and closes the gap below the threshold → the alert is resolved by `system`
  with resolution `late_activity`.
- **Working, not clocked in:** an event for an employee with no open session and no
  session covering `occurred_at`, and no open not-clocked-in alert already → open one
  (`from_at` = first such activity). Resolved by `system` (`clocked_in`) when the
  employee starts a session.

### 5.4 Manager actions — `/admin/alerts`
- `GET /admin/alerts?status=open` — list with employee name, kind, from/to, employee note.
- `POST /admin/alerts/:id/dismiss`.
- `POST /admin/alerts/:id/end-at-last-activity` — only for an `idle` alert whose
  `to_at` is NULL (the employee did not resume). Ends the session at `from_at` through the
  same path as a manager edit, writes `edits_log` with an Arabic auto-reason, resolves the
  alert. Any other case → `409 ALERT_NOT_ENDABLE`.
All under `authed, managerOnly`; alert must belong to the manager's location.

### 5.5 Employee — `/me/alerts`
- `GET /me/alerts` — own open alerts.
- `POST /me/alerts/:id/note` — body `{ note }` (≤ 300 chars); only on own alert.

### 5.6 Session summary
Computed and stored when a session closes by any path (employee stop, auto-close,
manager edit, end-at-last-activity), only if monitoring was on for any part of it:
`activity_count`, `last_activity_at`, and `longest_idle_sec` = the longest gap between
consecutive points {start, events…, end}, **with break time (employee and fixed)
removed from each gap**.

### 5.7 Retention
Every 15 minutes (timer) and lazily: `DELETE FROM activity_events WHERE occurred_at < now − 90 days` (the lazy run is on `GET /admin/ghl-connection`).

## 6. Interface

**Manager**
- Settings: toggle "مراقبة النشاط", "حد الخمول (دقائق)" 10–240, connection status
  ("✓ مربوط — آخر حدث وصل: 11:42" / "✗ غير مربوط — أعد تثبيت التطبيق من الـ Marketplace"),
  and the note "لازم يكون الموظفين عارفين إنه نشاطهم مراقب".
- Dashboard: "تنبيهات النشاط" panel at the top, only when alerts are open, with count;
  each row: name, "بدون نشاط من 11:20 · 45 د" or "عم يشتغل بدون دوام من 09:05",
  employee note if any, buttons "تجاهل" and "إنهاء الجلسة عند آخر نشاط" (only when allowed).
- Live floor: idle employees stay in "داخل الدوام" with a warning chip "بدون نشاط 35 د";
  working-without-session employees show "نشِط بدون دوام" in "غير متصل".
- Session detail: columns "النشاط" (count or "—") and "أطول خمول"; a tag
  "للمراجعة" / "انتهت عند آخر نشاط" when the session had an alert.

**Employee**
- On opening the page: idle alert → "جلستك فيها فترة بدون نشاط من 11:20 لـ 12:05، والمدير
  رح يراجعها" with "كنت عم اشتغل" (short reason box, sent with the alert).
  Not-clocked-in → "مبيّن إنك عم تشتغل من 09:05. بتبلّش الدوام؟" with the normal start
  button; the session starts **now**, never back-dated by the employee.
- A permanent small line "مراقبة النشاط مفعّلة" while monitoring is on.

## 7. Errors (new codes, documented in PROJECT.md §8)

`WEBHOOK_BAD_SIGNATURE` (401), `PAYLOAD_TOO_LARGE` (413, webhook body over 256 KB), `ALERT_NOT_FOUND` (404), `ALERT_NOT_ENDABLE` (409),
`NOTE_TOO_LONG` reused for employee notes over 300, `INVALID_IDLE_MINUTES` (400),
`INVALID_ACTIVITY_MONITORING` (400),
`OAUTH_EXCHANGE_FAILED` (GHL refused the code, 502) and `OAUTH_UNREACHABLE` (GHL not reached
within 10 s, 504) — both shown as pages, not JSON.

## 8. Testing

- Unit: gap computation with breaks and `activity_monitoring_since`; session summary;
  Ed25519 verification; token encryption round-trip.
- Smoke (local): fake webhooks signed with a **test key pair**. The test public key is
  accepted **only when `NODE_ENV` is `development` or `test`** (fails closed, stricter than
  dev-login). Against production the smoke test records one "refused" check and skips the
  test-signed checks. Checks: bad
  signature rejected; duplicate `webhook_id` stored once; activity recorded only for
  monitored locations and known employees; idle alert raised (backdated sessions);
  no idle during a break; late event resolves; not-clocked-in alert and auto-resolve on
  start; dismiss; end-at-last-activity writes `edits_log`; employee note; summary on stop;
  retention delete.
- Frontend: settings controls and status, alerts panel and actions, employee banners.

## 9. Delivery — two phases, each with its own plan

**Phase A — connection and activity collection.** Migration 004 (all tables/columns
above), OAuth callback, webhook receiver with signature + dedupe, settings toggle and
connection status, `last_event_at`, retention. Then **verify on Innova**: events arrive
with `userId`; identify the field that marks automated messages; confirm mobile-app
messages. The findings update §2 before phase B.

**Phase B — detection, alerts and UI.** Detector, alerts API, manager panel, live-floor
chips, session summary columns, employee banners and notes.

Rollout for each phase: migration first → deploy (monitoring off by default, no change
for anyone) → Marketplace settings + env vars → reinstall and enable on **Innova only**,
observe a few days with the manager, then offer to other clients.

## 10. Self-review

- No placeholders; the only open fact (how automated messages are marked) is an explicit
  phase-A verification step, not a guess built into phase B.
- Money: zero added cost (webhooks and OAuth are free; no premium workflow trigger).
- Fairness: activity never changes hours by itself; every alert is answerable by the
  employee; outages and late events cannot create idle alerts.
- Privacy: no content stored; raw events kept 90 days; summaries and alerts kept.
