# NourSky TimeClock — Early-leave approval (Design Spec)

**Date:** 2026-10-07 · **Status:** approved in brainstorming (owner), not yet implemented

## 1. Goal

When a company turns it on, an employee cannot end the shift before the company's work end time
on their own. They send a request with a reason; the manager approves (the shift ends at that
moment) or rejects (the employee stays clocked in and may ask again). Every request and answer is
kept, and both the employee and the manager can read the history.

Decisions taken with the owner (2026-10-07):

| Question | Decision |
|---|---|
| "Before the shift is over" means | before today's `work_end` (option A), not the daily target |
| Who gets it | a per-company setting, **off by default** |
| On approval the session ends at | **the moment the manager approves** (option B) |
| Employee reason | **required** |
| Manager note on rejection | optional |
| No answer | the request stays pending; the employee may cancel it; it closes by itself at work end or when the session ends some other way |
| History | kept forever, never edited or deleted; readable by the employee (own) and the manager (all) |

## 2. When approval is needed

`earlyLeaveRequired(st, now)` (pure, `src/activity.js`) is true when **all** hold:
- `settings.early_leave_approval = 1`;
- `work_start` and `work_end` are set and `work_start < work_end`;
- today (location timezone) is a working day (`work_days` bit);
- `now` is before today's `work_end` in the location timezone.

Otherwise the employee clocks out as today. Before `work_start` on a working day counts as before
work end (rare: an employee who clocks in early and wants to leave before the day even starts still
asks). The same function returns today's work end as a UNIX time (`workEndAt(st, now)`), stored on
the request.

## 3. Data (migration `007_early_leave.sql`)

```sql
ALTER TABLE settings ADD COLUMN early_leave_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER note_on_stop;
ALTER TABLE sessions MODIFY closed_by ENUM('user','auto','admin','approved') NULL;

CREATE TABLE IF NOT EXISTS early_leave_requests (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  location_id   VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(64)  NOT NULL,
  session_id    CHAR(36)     NOT NULL,
  reason        VARCHAR(300) NOT NULL,
  requested_at  BIGINT       NOT NULL,
  work_end_at   BIGINT       NOT NULL,  -- today's work end when asked; the request expires then
  status        ENUM('pending','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'pending',
  decided_by    VARCHAR(64)  NULL,      -- manager user id (approve/reject); NULL otherwise
  decided_at    BIGINT       NULL,      -- approve/reject/cancel/expire time
  manager_note  VARCHAR(300) NULL,
  -- 1 while pending, NULL otherwise: one pending request per session (numeric flag, MariaDB-safe).
  pending_flag  TINYINT GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED,
  UNIQUE KEY ux_early_leave_pending (session_id, pending_flag),
  KEY ix_early_leave_loc_time (location_id, requested_at),
  KEY ix_early_leave_user_time (location_id, user_id, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Also added to `schema.sql`. Applied in phpMyAdmin **before** the code is pushed.

Statuses: `pending` → `approved` | `rejected` | `cancelled` (by the employee) | `expired` (work end
passed, or the session ended by stop after work end, auto-close or a manager edit, with no answer).
Only a pending row ever changes, and only once.

## 4. API

All times UNIX seconds. `location_id`/`user_id` from the token only. Errors as `{ error: CODE }`.

**Employee**
- `GET /me/status` gains `early_leave`:
  `{ required: bool, work_end_at: ts|null, pending: Request|null, last: Request|null }` —
  `last` = the employee's newest non-pending request of today (location day), with its
  `session_id`. The screen shows a rejection banner when `last` is `rejected` for the open session,
  and "approved, your shift ended at 15:40" when `last` is `approved` and no session is open.
- `POST /session/stop` — when `earlyLeaveRequired` → `409 EARLY_LEAVE_NEEDS_APPROVAL` (checked
  inside the stop transaction, so a crafted request cannot skip it).
- `POST /me/early-leave` body `{ reason }` → `201` the request.
  `409 NO_OPEN_SESSION` · `409 EARLY_LEAVE_NOT_REQUIRED` (just clock out) ·
  `400 REASON_REQUIRED` (empty after trim) · `400 REASON_TOO_LONG` (> 300) ·
  `409 EARLY_LEAVE_PENDING` (one already pending; the unique key also enforces it).
- `POST /me/early-leave/:id/cancel` → own pending request becomes `cancelled`; else
  `404 REQUEST_NOT_FOUND`.
- `GET /me/early-leave?days=30` → own requests (1–90 days, default 30), newest first, with the
  deciding manager's name.

**Manager** (`authed, managerOnly`)
- `GET /admin/early-leave?status=pending|all&days=30` → requests of the location with employee and
  manager names, newest first (`pending` ignores `days`).
- `POST /admin/early-leave/:id/approve` → in one transaction: the pending request and its open
  session `FOR UPDATE`; the session ends now (`closed_by = 'approved'`, `note = reason`, an open
  break ends at the same instant); the request becomes `approved` (`decided_by`, `decided_at`).
  Then idle alerts of the session close and the activity summary runs, as after a normal stop.
  `404 REQUEST_NOT_FOUND` (not pending / other location) · `409 REQUEST_EXPIRED` (session already
  ended — the request is marked `expired`).
- `POST /admin/early-leave/:id/reject` body `{ note? }` (≤ 300 → else `400 NOTE_TOO_LONG`) →
  `rejected`. `404 REQUEST_NOT_FOUND` as above.
- `GET/PUT /admin/settings` gain `early_leave_approval` (boolean; absent = keep).

**Expiry** — `expireEarlyLeave(loc)`: pending rows with `now >= work_end_at` or whose session has
ended become `expired` (`decided_at = now`). Runs inside `autoCloseStale` (so before every read)
and on the existing 60 s timer.

New error codes go in `PROJECT.md` §8.

## 5. Interface

**Employee screen**
- "إنهاء الدوام" when `early_leave.required`: a dialog — "دوامك بينتهي الساعة 18:00. لتطلع قبل،
  لازم موافقة المدير." — with a required reason box and "إرسال الطلب". (Not the stop-note dialog.)
- Pending: a banner "طلبك لإنهاء الدوام عند المدير (السبب: …)" with "إلغاء الطلب"; the end button is
  disabled while pending.
- Rejected (`last.status = rejected`): banner "رفض المدير طلبك الساعة 15:20" + the manager's note +
  "فيك تبعت طلب جديد"; the end button opens the request dialog again.
- Approved: on the next refresh the screen shows "not clocked in" and a banner "وافق المدير، انتهى دوامك
  الساعة 15:40" (from `early_leave.last`).
- "طلباتي" section under "سجلّي": the last 30 days — date, request time, reason, status, who answered
  and when, manager note.

**Manager dashboard**
- "طلبات الإنهاء المبكر" panel at the top (beside activity alerts), two tabs:
  - **Pending:** name, request time, reason, "موافقة" and "رفض" (reject opens an optional note box).
  - **السجل:** every request of the last 30 days, newest first, searchable by name, all fields.
- ⚠️ in the tab title while a request is pending (the existing `useAlertTitle`).
- Refresh with `usePolling` every 30 s and on tab return.
- Report detail and CSV: `closed_by = approved` reads "انتهت بموافقة المدير" / "Ended with manager
  approval"; the note column shows the reason.

**Settings** — checkbox "الإنهاء قبل نهاية الدوام بيحتاج موافقة المدير" with the hint "لازم يكون وقت نهاية
الدوام محدد".

All text in `locales/ar.js` and `en.js`; Western digits; logical CSS.

## 6. Testing

- Unit (`activity.test.mjs`): `earlyLeaveRequired` / `workEndAt` — setting off, no work_end,
  day off, before/after work end, timezone (Asia/Damascus vs UTC).
- Smoke: stop refused before work end only when on; request without reason / too long; one pending;
  approve ends the session at approval with `closed_by=approved`, note = reason, open break closed;
  reject keeps the session and allows a new request; cancel; expiry at work end and on auto-close;
  another location's manager gets 404; histories for employee and manager; settings
  saved/kept; `EARLY_LEAVE_NOT_REQUIRED` after work end.
- Frontend: request dialog (reason required), pending/rejected banners, end button disabled while
  pending, "طلباتي" list, manager pending list approve/reject with note, history tab and search,
  settings checkbox, English rendering, title ⚠️.

## 7. Delivery

Migration 007 in phpMyAdmin → push → deploy log checked → owner turns the setting on for Terra.
