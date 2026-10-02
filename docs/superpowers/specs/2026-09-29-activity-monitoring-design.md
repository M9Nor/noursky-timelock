# NourSky TimeClock — Activity Monitoring (Design Spec)

**Date:** 2026-09-29 · **Revised:** 2026-10-02 (phase B scope, after the Innova verification)
**Status:** phase A live; phase B approved in brainstorming, not yet implemented
**Owner decision:** activity from GHL is used as **evidence and alerts**, never as the clock.

> **2026-10-02 revision.** Innova only delivers Instagram and Email today, so a quiet
> stretch is weak evidence. Phase B therefore ships **one** alert — *working, not clocked
> in*, inside working hours only — and shows idle time as **information** (live-floor chip
> and session columns), never as an alert. The idle alert, "end at last activity" and the
> employee idle banner are deferred (§11). New settings `work_end` and `work_days` define
> working hours (migration 005).

## 1. Goal

Help managers catch the two failures manual clock-in cannot see on its own:

1. an employee is **working in GHL but never clocked in** (forgot to start) — an alert;
2. an employee **clocked in but shows no activity** for a long stretch (idle, or forgot to
   stop) — shown to the manager as information in phase B; an alert later (§11).

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
  person's activity. What distinguishes them is recorded in §2.1.
- Messages sent from the GHL mobile app arrive the same way and count.

Rejected: polling the GHL API (slower, many calls, rate limits) and the internal
audit-log endpoint (see §1.2).

### 2.1 Verified on Innova (2026-10-02)

First real deliveries after the 2.0.0 install. Each event was matched against the
conversation in GHL (sender and minute):

| Event | `messageType` | `source` | `userId` | What it was |
|---|---|---|---|---|
| Instagram reply | `IG` | `app` | **absent** | automatic reply in the same minute as the contact's message, no team member named |
| Instagram message | `IG` | `app` | present | typed by a team member (shown as "MA" in the thread) |
| Email | `Email` | `app` | present | sent by the same team member |

- **Rule adopted for phase B:** only events **with** a `userId` count as a person's
  activity. An automatic reply arrives without one, so it can never make someone look
  active.
- `source` is `app` for both automatic and typed messages — it does **not** separate them.
- Not yet observed, because those channels are not connected on Innova: SMS, WhatsApp,
  outbound call, internal comment, mobile app, bulk action, workflow. In particular, a
  bulk or workflow send started by a team member may still carry that member's `userId`;
  this must be checked on an account where those channels exist before phase B counts
  them, and until then the `userId` rule above is the only filter.

## 3. GHL app changes (Marketplace, one time)

| Setting | Value |
|---|---|
| Scope added | `conversations/message.readonly` (read-only; no write scope) |
| Webhook URL | `https://timeclock.noursky.com/webhooks/events` · subscribe `OutboundMessage` (+ app install/uninstall events, delivered by default) |
| Redirect URL (OAuth) | `https://timeclock.noursky.com/oauth/callback` |

Each client Sub-Account must **reinstall once** and accept the new scope. Until then the
account works exactly as today. (Published 2026-10-02 as **2.0.0**: GHL forces a major
version when a scope is added, so existing installs stay on 1.0.0 until someone presses
Update in that Sub-Account.)

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

`settings` (migration **005**, phase B):
- `work_end` CHAR(5) NULL — `HH:MM`, location timezone, same format as `work_start`;
  must be later than `work_start` on the same day (no overnight hours). NULL by default:
  until the manager sets it, no not-clocked-in alerts are raised.
- `work_days` TINYINT UNSIGNED NOT NULL DEFAULT 127 — bitmask of working weekdays in the
  location's timezone, bit 0 = Sunday … bit 6 = Saturday (JavaScript `getDay()` order).
  Allowed 1–127. Default = every day.

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

### 5.3 Detection (phase B)
No timer: the alert is decided **when an event is stored** (inside `POST /webhooks/events`),
and idle time is computed **when it is read**. The pure rules live in a new module
`src/activity.js` (no database, unit-tested, same pattern as `src/tz.js`).

**What counts as a person's activity:** an `activity_events` row **with** a `user_id`
(§2.1). Rows without one are kept for 90 days but never count.

**Working, not clocked in** — after an event is stored, open a
`working_not_clocked_in` alert (`from_at` = the event's `occurred_at`) when **all** hold:
1. the event has a `user_id`, and `employees` has that user at this location with
   `role = 'employee'` (managers never get this alert; users who never opened TimeClock
   are not alerted — they are counted instead, see §5.4);
2. `occurred_at` is on a working day (`work_days`) and between `work_start` and
   `work_end`, in the location's timezone (DST-aware via `src/tz.js`); if either time is
   NULL, no alert;
3. the employee has no open session and no session covering `occurred_at`;
4. `occurred_at` is not older than **6 hours** and not more than 5 minutes in the future
   (a replayed or badly delayed event is stored but opens nothing);
5. no open not-clocked-in alert exists for that employee — enforced by the existing
   `ux_alert_nci_open` unique key (`INSERT IGNORE`).

Resolved by `system` with `clocked_in` when the employee starts a session, or by the
manager with `dismissed`. The employee cannot resolve it.

**Idle (information only)** — for each open session, last activity = the latest of
`session.started_at`, `activity_monitoring_since`, and the employee's last counted
event in the session. Idle seconds = `now − last activity`, **minus** break time
(employee breaks and fixed windows) inside that stretch. Shown when it exceeds
`idle_minutes` (default 30, 10–240). No alert row is written.

**Outage guard:** idle is shown only when the location's latest `activity_events` row is
less than 24 hours old. (`ghl_installs.last_event_at` is not used for this: other apps'
signed events also refresh it.)

### 5.4 Manager actions — `/admin/alerts`
- `GET /admin/alerts?status=open` — list with employee name, kind, `from_at`, employee note.
- `POST /admin/alerts/:id/dismiss` — open alert of this location → `dismissed`;
  otherwise `404 ALERT_NOT_FOUND`.
- `GET /admin/live` gains, per open session, `last_activity_at` and `idle_sec` (NULL when
  monitoring is off or the outage guard applies), and per offline employee
  `active_without_session` (true while a not-clocked-in alert is open).
- `GET /admin/sessions` and the CSV gain `activity_count` and `longest_idle_sec`.
- `GET /admin/ghl-connection` gains `unknown_active_users` = number of distinct
  `user_id`s with counted events in the last 7 days that have no `employees` row at this
  location.
- `PUT /admin/settings` accepts `work_end` (`HH:MM` or null, later than `work_start` →
  else `400 INVALID_WORK_END`) and `work_days` (integer 1–127 → else
  `400 INVALID_WORK_DAYS`). **A field absent from the body keeps its stored value** for
  every setting, so an older page cannot reset newer fields.
All under `authed, managerOnly`; alert must belong to the manager's location.
(`end-at-last-activity` is deferred with the idle alert, §11.)

### 5.5 Employee — `/me/alerts`
- `GET /me/alerts` — own open alerts.
- `POST /me/alerts/:id/note` — body `{ note }` (≤ 300 chars); only on own alert.

- `GET /me/status` gains `activity_monitoring` (for the "مراقبة النشاط مفعّلة" line).

### 5.6 Session summary
Computed and stored when a session closes by any path (employee stop, auto-close,
manager edit), and recomputed when a manager edits a closed session, only if monitoring
was on for any part of it. Only counted events (with `user_id`) are used:
`activity_count`, `last_activity_at`, and `longest_idle_sec` = the longest gap between
consecutive points {start, events…, end}, **with break time (employee and fixed)
removed from each gap**. Outage guard: if no event at all reached the location in the 24 h
before the session ended, the summary is left empty (null, shown "—") rather than stored as
"0 activity". A manager edit refills the summary whatever the session's age.

### 5.7 Retention
Every 15 minutes (timer) and lazily: `DELETE FROM activity_events WHERE occurred_at < now − 90 days` (the lazy run is on `GET /admin/ghl-connection`).

## 6. Interface

**Manager**
- Settings: toggle "مراقبة النشاط", "حد الخمول (دقائق)" 10–240, connection status
  ("✓ مربوط — آخر حدث وصل: 11:42" / "✗ غير مربوط — أعد تثبيت التطبيق من الـ Marketplace"),
  and the note "لازم يكون الموظفين عارفين إنه نشاطهم مراقب".
  Phase B adds: "نهاية الدوام" next to "بداية الدوام"; "أيام الدوام" as seven
  checkboxes (السبت … الجمعة); while monitoring is on and a time is missing, the hint
  "حدّد بداية ونهاية الدوام لتشتغل تنبيهات العمل بدون دوام"; and, when
  `unknown_active_users > 0`, "في نشاط بآخر 7 أيام من X مستخدمين ما فتحوا TimeClock بعد".
- Dashboard: "تنبيهات النشاط" panel at the top, only when alerts are open, with count;
  each row: name, "عم يشتغل بدون دوام من 09:05", employee note if any, button "تجاهل".
- Live floor: idle employees stay in "داخل الدوام" with a warning chip "بدون نشاط 35 د";
  working-without-session employees show "نشِط بدون دوام" in "غير متصل".
- Session detail: columns "النشاط" (count or "—") and "أطول خمول" ("—" when not monitored).

**Employee**
- Not-clocked-in alert open → "مبيّن إنك عم تشتغل من 09:05. بتبلّش الدوام؟" with the normal
  start button (the session starts **now**, never back-dated) and a short note box sent to
  the manager with the alert.
- A permanent small line "مراقبة النشاط مفعّلة" while monitoring is on.

## 7. Errors (new codes, documented in PROJECT.md §8)

`WEBHOOK_BAD_SIGNATURE` (401), `PAYLOAD_TOO_LARGE` (413, webhook body over 256 KB), `ALERT_NOT_FOUND` (404), `ALERT_NOT_ENDABLE` (409, deferred with §11),
`INVALID_WORK_END` (400), `INVALID_WORK_DAYS` (400),
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
  test-signed checks. Phase A checks (done): bad signature rejected; duplicate
  `webhook_id` stored once; activity recorded only for monitored locations; retention
  delete. The draft's idle-alert, late-event and end-at-last-activity checks are replaced
  by the phase B list below (§11).
- Frontend: settings controls and status, alerts panel and actions, employee banners.
- **Phase B (2026-10-02 scope):**
  - Unit (`src/activity.js`): inside/outside working hours in a non-UTC zone across a DST
    change; day off; NULL `work_start`/`work_end`; idle seconds with employee breaks,
    fixed windows and `activity_monitoring_since`; session summary; replay window.
  - Smoke: not-clocked-in alert opens inside hours; not outside hours, on a day off, for a
    manager, for an employee with an open or covering session, for an event without
    `user_id`, or for an event older than 6 hours; only one open alert per employee;
    auto-resolved on start; dismiss; employee note and its 300-char limit; another
    location's alert is 404; `work_end`/`work_days` validation; absent settings fields
    keep their value; live `idle_sec`; summary stored on stop; `unknown_active_users`.

## 9. Delivery — two phases, each with its own plan

**Phase A — connection and activity collection.** Migration 004 (all tables/columns
above), OAuth callback, webhook receiver with signature + dedupe, settings toggle and
connection status, `last_event_at`, retention. Then **verify on Innova**: events arrive
with `userId`; identify the field that marks automated messages; confirm mobile-app
messages. The findings update §2 before phase B.

**Phase B — detection, alerts and UI.** Migration 005 (`work_end`, `work_days`),
`src/activity.js`, not-clocked-in alert on event arrival, alerts API, manager panel,
live-floor chips, session summary columns, employee banner and note, settings fields,
unknown-users count. Rollout: migration 005 in phpMyAdmin → push → Innova's manager sets
"نهاية الدوام" and "أيام الدوام".

Phase-A review items carried into phase B: trim `GHL_APP_ID` and log a mismatch once;
"absent = keep" for every `PUT /admin/settings` field; the outage guard reads
`activity_events`, not `last_event_at`; a replay/delay window for alerts (§5.3). Still
parked (no phase-B code decrypts tokens or writes idle alerts): GCM hardening before any
`decryptToken` use, and always setting `session_id` on idle alerts.

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

## 11. Deferred (decided 2026-10-02)

Not in phase B; the tables and columns already exist from migration 004, so bringing
them back needs no migration:
- the `idle` alert (open/resume/late-activity rules from the 2026-09-29 draft of §5.3);
- `POST /admin/alerts/:id/end-at-last-activity` and `409 ALERT_NOT_ENDABLE`;
- the employee idle banner ("جلستك فيها فترة بدون نشاط…").

Revisit when more channels (SMS, WhatsApp, calls) are connected on a client account and
the idle chip has been observed against real days. Reason for deferring: on Innova a
quiet stretch is weak evidence, and an alert with an "end session" button is the closest
thing in this product to a pay deduction.
