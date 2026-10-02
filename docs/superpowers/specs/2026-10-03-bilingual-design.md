# NourSky TimeClock — Arabic + English (Design Spec)

**Date:** 2026-10-03 · **Status:** approved in brainstorming (owner), not yet implemented

## 1. Goal

Every screen of the app works in **Arabic (RTL)** and **English (LTR)**. The manager picks the
company language; each user can switch for themselves. Also: the working-hours and break time
fields become a time picker instead of typed `HH:MM` text (owner, same request).

Out of scope now: the Marketplace listing in English. The English client guide comes last, after
the code ships.

## 2. Language choice

- **Company language** — `settings.locale` ENUM('ar','en') NOT NULL DEFAULT 'ar' (every existing
  client stays Arabic). The manager sets it in Settings ("لغة الشركة" / "Company language").
- **Personal language** — `employees.locale` ENUM('ar','en') NULL. NULL = follow the company.
  Set by the language button in the top bar.
- **Effective language** = personal ?? company ?? 'ar'.

GHL's SSO payload does not reliably carry a language, so the first visit uses the company language.

## 3. Data (migration `006`)

```sql
ALTER TABLE settings ADD COLUMN locale ENUM('ar','en') NOT NULL DEFAULT 'ar' AFTER timezone;
ALTER TABLE employees ADD COLUMN locale ENUM('ar','en') NULL AFTER role;
```

Apply in phpMyAdmin **before** pushing the code (the login query reads `employees.locale`).

## 4. API

- `POST /auth/sso` and `POST /auth/dev-login`: the response `user` gains `locale` (effective). The
  employee upsert never overwrites `employees.locale`. The token's claims are unchanged.
- `PUT /me/locale` (authed) — body `{ locale: "ar" | "en" | null }`; null clears the personal choice.
  Returns `{ locale }` (effective). Anything else → `400 INVALID_LOCALE`.
- `GET /admin/settings` returns `locale`; `PUT /admin/settings` accepts `locale` ("absent = keep";
  not `ar`/`en` → `400 INVALID_LOCALE`).
- Error responses stay codes only; the UI translates them.
- **Install pages** (`GET /oauth/callback`) are shown before we know the user: Arabic when the
  browser's first `Accept-Language` tag is Arabic (`ar…`), otherwise English. `<html lang dir>` match.

## 5. Interface

- A small home-made module `web/src/i18n.js` (no new dependency): `ar` and `en` dictionaries with
  the **same keys**, `{name}`-style interpolation, an `I18nProvider` and a `useI18n()` hook returning
  `{ locale, t, setLocale }`. Without a provider the hook returns Arabic, so a component rendered on
  its own (e.g. in a test) behaves as today.
- On a language change the app sets `<html lang>` and `dir` (`rtl` / `ltr`) and the tab title
  ("الدوام" / "TimeClock") at once — no reload — and saves the personal choice (`PUT /me/locale`;
  a failure keeps the switch for this visit and is not shown as an error).
- Top bar: one button showing the *other* language ("English" while Arabic, "عربي" while English).
- Numbers stay Western digits (1, 2, 3) in both languages; times stay 24-hour (`09:05`). Duration
  units: "25 د" / "25 min", "1 س 5 د" / "1 h 5 min"; lateness "متأخر 5 د" / "5 min late".
  Dates use `en-GB` formatting in both; the top-bar date label uses Arabic or English month/day names.
- Layout mirrors with direction: physical `text-align: right` and similar CSS become logical
  (`start` / `end`, `inset-inline-*`, `margin-inline-*`) so both directions render correctly.
- Employee names come from GHL and are never translated.
- **Time pickers:** "بداية الدوام", "نهاية الدوام", "بداية الاستراحة", "نهاية الاستراحة" become
  `<input type="time">` (value `HH:MM`, empty = not set). Labels drop the "(HH:MM)" hint.

## 6. Testing

- Server smoke: migration columns; `user.locale` on login (company default, then personal);
  `PUT /me/locale` ar/en/null and `INVALID_LOCALE`; settings `locale` saved/kept/rejected; install page
  language by `Accept-Language`.
- Frontend: dictionaries have identical key sets and the English one contains no Arabic letters; no
  Arabic text remains in component source outside `i18n.js` (a source scan test); key screens render in
  English inside an `en` provider; the top-bar button switches language and `dir`; the settings time
  fields are time inputs and still save `HH:MM`. Existing tests keep running in Arabic.

## 7. Delivery

Migration 006 in phpMyAdmin → push → (owner) choose the company language per client.
