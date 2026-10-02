# Arabic + English and Time Pickers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every screen works in Arabic (RTL) and English (LTR) — company language set by the manager, personal override from the top bar — and the working-hours / break time fields become time pickers.

**Architecture:** Migration 006 adds `settings.locale` and `employees.locale`; the login response carries the effective language; `PUT /me/locale` and `PUT /admin/settings` store it; the install pages pick a language from `Accept-Language`. In the SPA a small home-made `web/src/i18n.jsx` (dictionaries in `web/src/locales/ar.js` and `en.js`) provides `useI18n()`; components replace Arabic literals with `t("key")`; `time.js` formatters take a locale; CSS becomes direction-neutral.

**Tech Stack:** Node 20 ESM · Hono · mysql2 · React 18 · Vitest 2 + RTL · MariaDB (Docker `timeclock-db`)

**Spec:** `docs/superpowers/specs/2026-10-03-bilingual-design.md`

## Global Constraints

- No new dependencies. SQL portable to MySQL 8 and MariaDB 10.2+. `location_id`/`user_id` from claims only.
- Locales are exactly `ar` and `en`. Company default `ar`; effective = personal ?? company ?? `ar`. Anything else → `400 INVALID_LOCALE`.
- Without an `I18nProvider`, `useI18n()` returns Arabic — existing tests keep passing unchanged.
- `<html lang>` / `dir` follow the language (`ar` → `rtl`, `en` → `ltr`); the tab title is "الدوام" / "TimeClock" (a leading `⚠️ ` from `useAlertTitle` is preserved).
- Western digits in both languages; times 24-hour; durations "25 د" / "25 min", "1 س 5 د" / "1 h 5 min"; lateness "متأخر 5 د" / "5 min late".
- Employee names are never translated. Error codes stay codes; the UI translates them.
- English dictionary contains no Arabic letters; both dictionaries have identical key sets; translated component files contain no Arabic letters (comments included — write them in English).
- Time fields (`work_start`, `work_end`, `break_start`, `break_end`) are `<input type="time">`; empty means not set (sent as `null`).
- Migration 006 is applied in production before the code ships. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push from a task.

## Glossary (use these English terms consistently)

| Arabic | English |
|---|---|
| الدوام (app) | TimeClock |
| بدء الدوام / إنهاء الدوام | Clock in / Clock out |
| استراحة / إنهاء الاستراحة | Break / End break |
| داخل الدوام / لم يسجّل الدخول / في استراحة / وقت الاستراحة | Clocked in / Not clocked in / On break / Break time |
| مجموع اليوم / المتبقي / ساعات اليوم المطلوبة / اكتملت | Today's total / Remaining / Today's target / Done |
| ساعاتي هذا الأسبوع / سجلّي — آخر 7 أيام | My hours this week / My history — last 7 days |
| الفريق الآن / غير متصل | Team now / Offline |
| التقرير / الإعدادات / حفظ / تم الحفظ / تعديل / تجاهل | Report / Settings / Save / Saved / Edit / Dismiss |
| تنبيهات النشاط / ملاحظات الموظفين / مراقبة النشاط | Activity alerts / Employee notes / Activity monitoring |
| بدون نشاط / نشِط بدون دوام | No activity / Active, not clocked in |
| عم يشتغل بدون دوام من {time} | Working without clocking in since {time} |
| ما في نشاط من {time} ({dur})، والمدير رح يشوفها… | No activity since {time} ({dur}). Your manager will see this. If you're working, tell them what you're doing. |
| مبيّن إنك عم تشتغل من {time}. بتبلّش الدوام؟ | Looks like you've been working since {time}. Clock in? |
| ملاحظة للمدير / إرسال الملاحظة | Note to manager / Send note |
| المنطقة الزمنية / الهدف اليومي (ساعات) / حد الجلسة (ساعات) | Timezone / Daily target (hours) / Max session (hours) |
| بداية الدوام / نهاية الدوام / أيام الدوام / سماح التأخير (دقائق) | Work start / Work end / Work days / Late grace (minutes) |
| نوع الاستراحة: بدون / ثابتة / مرنة · مدفوعة | Break type: None / Fixed / Flexible · Paid |
| ملاحظة عند إنهاء الدوام: بدون / اختيارية / إلزامية | Note when clocking out: Off / Optional / Required |
| حد الخمول (دقائق) / لغة الشركة | Idle threshold (minutes) / Company language |
| الموظف / ساعات العمل / الهدف / الإنجاز / أيام الحضور / أيام التأخير / مغلقة تلقائياً | Employee / Hours worked / Target / Completion / Days present / Late days / Auto-closed |
| اليوم / الأسبوع / الشهر / من / إلى / بحث عن موظف / تصدير CSV | Today / Week / Month / From / To / Search employee / Export CSV |
| مربوط / غير مربوط | Connected / Not connected |
| حدث خطأ، حاول مرة أخرى | Something went wrong, please try again |
| انتهت الجلسة، أعد فتح الصفحة / جارٍ التحميل… / جارٍ التحقق… | Session expired, reopen the page / Loading… / Checking… |
| أيام: السبت…الجمعة | Saturday … Friday |

Day names: السبت Saturday, الأحد Sunday, الاثنين Monday, الثلاثاء Tuesday, الأربعاء Wednesday, الخميس Thursday, الجمعة Friday.

## Shared commands

```bash
cd /Users/Yasin/Projects/superpowers/noursky-timelock
open -a Docker; docker start timeclock-db
pkill -f "node --env-file=.env src/server.js"; nohup node --env-file=.env src/server.js > /private/tmp/claude-502/timeclock-server.log 2>&1 &
until curl -s -m 2 http://localhost:3000/health | grep -q '"ok":true'; do sleep 1; done; echo up
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=$(grep -m1 '^GHL_SHARED_SECRET=' .env | cut -d= -f2-) node --env-file=.env scripts/smoke-test.mjs 2>&1 | grep -E "^  FAIL|SKIP|passed"
npm run test:unit
cd web && npx vitest run
```

**Baseline:** smoke 198/0 (foreign-appId SKIP); unit 53; frontend 135.

---

### Task 1: Server — migration 006, locale API, bilingual install pages

**Files:** Create `migrations/006_locale.sql`. Modify `schema.sql`, `migrations/README.md`, `src/server.js`, `scripts/smoke-test.mjs`, `PROJECT.md` (§7, §8).

**Interfaces — Produces:** login response `user.locale` (`"ar"|"en"`); `PUT /me/locale` `{locale:"ar"|"en"|null}` → `{locale}`; settings `locale`; error `INVALID_LOCALE`.

- [ ] **Step 1: Migration**

`migrations/006_locale.sql`:

```sql
-- 006 · Arabic / English. Company language (settings) and a personal override (employees).
-- Apply BEFORE deploying the bilingual code: login reads employees.locale. Old code ignores both.
-- Portable across MySQL 8 and MariaDB 10.2+.
ALTER TABLE settings
  ADD COLUMN locale ENUM('ar','en') NOT NULL DEFAULT 'ar' AFTER timezone;
ALTER TABLE employees
  ADD COLUMN locale ENUM('ar','en') NULL AFTER role;
```

Add the same two columns to `schema.sql` (settings: after `timezone`; employees: after `role`, comment `-- personal language; NULL = follow the company`) and a README row `| \`006_locale.sql\` | _pending_ | run manually in phpMyAdmin before the bilingual deploy |`. Apply locally:
`set -a; . ./.env; set +a; docker exec -i timeclock-db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/006_locale.sql`.

- [ ] **Step 2: Failing smoke checks**

The two existing OAuth-callback checks fetch with no `Accept-Language` and expect Arabic text; make both requests send Arabic: `fetch(url, { headers: { "Accept-Language": "ar" } })`. Then, directly before `check("tampered token → 401", …)`, add:

```js
// --- Language (bilingual spec). Own location.
const LGLOC = `${LOC}-lg`;
const lgSso = (uid, role) => sso({ userId: `${LGLOC}-${uid}`, role, type: "account", activeLocation: LGLOC, userName: uid, email: `${uid}@x.com` });
const lgM = await lgSso("m1", "admin"), lgE = await lgSso("u1", "user");
check("a new user starts in the company language (Arabic by default)", lgE.body?.user?.locale === "ar", `(${JSON.stringify(lgE.body?.user)})`);
const lgSet = await call(lgM.body?.token, "PUT", "/admin/settings", { locale: "en" });
check("the manager sets the company language", lgSet.body?.locale === "en", `(${lgSet.status} ${JSON.stringify(lgSet.body?.error)})`);
check("users follow the company language", (await lgSso("u1", "user")).body?.user?.locale === "en");
check("a missing locale keeps the company language", (await call(lgM.body?.token, "PUT", "/admin/settings", { late_grace_minutes: 10 })).body?.locale === "en");
check("an unknown company language → 400", (await call(lgM.body?.token, "PUT", "/admin/settings", { locale: "fr" })).body?.error === "INVALID_LOCALE");
const lgMine = await call(lgE.body?.token, "PUT", "/me/locale", { locale: "ar" });
check("a user picks their own language", lgMine.status === 200 && lgMine.body?.locale === "ar");
check("the personal choice wins at the next login", (await lgSso("u1", "user")).body?.user?.locale === "ar");
check("clearing it follows the company again", (await call(lgE.body?.token, "PUT", "/me/locale", { locale: null })).body?.locale === "en");
check("an unknown personal language → 400", (await call(lgE.body?.token, "PUT", "/me/locale", { locale: "fr" })).body?.error === "INVALID_LOCALE");
check("a body without locale → 400", (await call(lgE.body?.token, "PUT", "/me/locale", {})).body?.error === "INVALID_LOCALE");
const lgInstallEn = await fetch(`${BASE}/oauth/callback`, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
const lgInstallEnText = await lgInstallEn.text();
check("the install page speaks English to an English browser",
  lgInstallEn.status === 400 && lgInstallEnText.includes('lang="en"') && lgInstallEnText.includes("Reinstall the app"));
const lgInstallAr = await (await fetch(`${BASE}/oauth/callback`, { headers: { "Accept-Language": "ar-SY,ar;q=0.9,en;q=0.5" } })).text();
check("the install page speaks Arabic to an Arabic browser", lgInstallAr.includes('dir="rtl"') && lgInstallAr.includes("أعد تثبيت التطبيق"));
await cleanupLocation(LGLOC);
```

Run → the new checks FAIL.

- [ ] **Step 3: Implement in `src/server.js`**

1. Near `NOTE_POLICIES`: `const LOCALES = ["ar", "en"];`
2. A helper above `issueSession`:

```js
/** Effective language of one user: personal choice, else the company's, else Arabic. */
async function effectiveLocale(uid, loc) {
  const [row] = await q(
    `SELECT e.locale AS personal, s.locale AS company
       FROM employees e LEFT JOIN settings s ON s.location_id = e.location_id
      WHERE e.user_id = :uid AND e.location_id = :loc`,
    { uid, loc }
  );
  return row?.personal ?? row?.company ?? "ar";
}
```

3. In `issueSession`, after the settings `INSERT IGNORE` and before building claims, compute `const locale = await effectiveLocale(userId, loc);`, and return `{ token: signToken(claims), user: { ...user, locale } }` (claims unchanged; the employee upsert does not touch `locale`).
4. After `GET /me/settings`, add:

```js
app.put("/me/locale", authed, async (c) => {
  const { uid, loc } = c.get("claims");
  const b = (await c.req.json().catch(() => null)) ?? {};
  if (b.locale !== null && !LOCALES.includes(b.locale)) throw new HttpError(400, "INVALID_LOCALE");
  await q(
    "UPDATE employees SET locale = :locale, updated_at = :t WHERE user_id = :uid AND location_id = :loc",
    { locale: b.locale, t: now(), uid, loc }
  );
  return c.json({ locale: await effectiveLocale(uid, loc) });
});
```

5. `PUT /admin/settings`: after the timezone checks add

```js
  const locale = pick("locale") ?? "ar";
  if (!LOCALES.includes(locale)) throw new HttpError(400, "INVALID_LOCALE");
```

   and add `locale = :locale,` to the settings `UPDATE` (with `locale` in its params).
6. Replace `installPage` with a bilingual version and a language picker:

```js
const INSTALL_TEXT = {
  ar: {
    failed: "تعذّر التثبيت", connected: "تم الربط",
    missingCode: "الرابط ناقص. أعد تثبيت التطبيق من الـ Marketplace.",
    notConfigured: "الربط مع GHL غير مُعدّ على السيرفر بعد. تواصل مع NourSky.",
    unreachable: "ما قدرنا نوصل لـ GHL. جرّب تعيد التثبيت بعد شوي.",
    refused: "GHL رفض طلب الربط. أعد تثبيت التطبيق من الـ Marketplace.",
    storeFailed: "صار خطأ أثناء حفظ الربط. أعد تثبيت التطبيق من الـ Marketplace.",
    done: "تم ربط TimeClock بحسابك. بتقدر تسكّر هالصفحة وترجع لـ GHL.",
  },
  en: {
    failed: "Installation failed", connected: "Connected",
    missingCode: "The link is incomplete. Reinstall the app from the Marketplace.",
    notConfigured: "The GHL connection is not set up on the server yet. Contact NourSky.",
    unreachable: "We couldn't reach GHL. Try reinstalling in a moment.",
    refused: "GHL refused the connection request. Reinstall the app from the Marketplace.",
    storeFailed: "Something went wrong while saving the connection. Reinstall the app from the Marketplace.",
    done: "TimeClock is connected to your account. You can close this page and return to GHL.",
  },
};
/** The install page runs before we know the user: Arabic for an Arabic browser, else English. */
function installLang(c) {
  const first = (c.req.header("accept-language") ?? "").split(",")[0].trim().toLowerCase();
  return first.startsWith("ar") ? "ar" : "en";
}
// A tiny self-contained page; the texts are fixed strings, never request data.
function installPage(c, titleKey, messageKey) {
  const lang = installLang(c);
  const tx = INSTALL_TEXT[lang];
  const title = tx[titleKey], message = tx[messageKey];
  return `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;background:#F7F6FB;color:#1D1B2E;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:460px;background:#fff;border:1px solid #E3E0F0;border-radius:14px;padding:28px}h1{color:#6C5CE7;font-size:20px;margin:0 0 10px}p{margin:0;line-height:1.8}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}
```

   and change the six call sites in `GET /oauth/callback` to `installPage(c, "failed", "missingCode")`, `(c, "failed", "notConfigured")`, `(c, "failed", "unreachable")`, `(c, "failed", "refused")`, `(c, "failed", "storeFailed")`, `(c, "connected", "done")` — keeping each one's status code.

- [ ] **Step 4:** restart, run smoke → **0 failed, 198 + 12 = 210 passed**; unit 53.
- [ ] **Step 5: Docs** — PROJECT.md §7 (`settings.locale`, `employees.locale`), §8 (`/auth/sso` user.locale; new `PUT /me/locale` row; settings `locale`; `/oauth/callback` language by `Accept-Language`; error row `| \`INVALID_LOCALE\` | 400 | اللغة مش \`ar\` أو \`en\` | — |`).
- [ ] **Step 6: Commit** `feat(i18n): company and personal language, bilingual install pages (migration 006)`.

---

### Task 2: Frontend foundation — i18n module, formatters, app shell, top-bar switch, direction-neutral CSS

**Files:** Create `web/src/i18n.jsx`, `web/src/i18n.test.jsx`, `web/src/locales/ar.js`, `web/src/locales/en.js`. Modify `web/src/time.js` (+ `time.test.js`), `web/src/App.jsx`, `web/src/components/TopBar.jsx` (+ `TopBar.test.jsx`), `web/src/styles.css`, `web/index.html`.

**Interfaces — Produces:** `I18nProvider({ locale, onChange, children })`, `useI18n() → { locale, t(key, vars?), setLocale(next) }`, `translate(locale, key, vars?)`; `formatIdle(sec, locale = "ar")`, `formatLateness(sec, locale = "ar")`, `formatBreak(sec, locale = "ar")`; `TRANSLATED_FILES` list in `i18n.test.jsx` that later tasks extend.

- [ ] **Step 1: Failing tests** — `web/src/i18n.test.jsx`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider, useI18n, translate } from "./i18n.jsx";
import ar from "./locales/ar.js";
import en from "./locales/en.js";

const ARABIC = /[؀-ۿ]/;
// Files whose user-visible text must come only from the dictionaries. Tasks 3–4 add theirs.
const TRANSLATED_FILES = ["App.jsx", "components/TopBar.jsx"];

describe("dictionaries", () => {
  it("have the same keys", () => { expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort()); });
  it("keep English free of Arabic letters", () => {
    expect(Object.entries(en).filter(([, v]) => ARABIC.test(v))).toEqual([]);
  });
  it("leave no Arabic text in translated files", () => {
    const offenders = TRANSLATED_FILES.filter((f) => ARABIC.test(readFileSync(new URL(`./${f}`, import.meta.url), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("translate", () => {
  it("fills {placeholders} and falls back to Arabic, then to the key", () => {
    expect(translate("en", "test.hello", { name: "Sara" })).toBe("Hello, Sara");
    expect(translate("ar", "test.hello", { name: "سارة" })).toBe("مرحباً، سارة");
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });
});

function Probe() {
  const { locale, t, setLocale } = useI18n();
  return <button onClick={() => setLocale(locale === "ar" ? "en" : "ar")}>{t("test.hello", { name: "x" })}</button>;
}

describe("I18nProvider", () => {
  it("defaults to Arabic without a provider", () => {
    render(<Probe />);
    expect(screen.getByRole("button")).toHaveTextContent("مرحباً، x");
  });
  it("switches language and direction and reports the change", () => {
    const changes = [];
    render(<I18nProvider locale="ar" onChange={(l) => changes.push(l)}><Probe /></I18nProvider>);
    expect(document.documentElement.dir).toBe("rtl");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Hello, x");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
    expect(changes).toEqual(["en"]);
  });
});
```

Add to `time.test.js`:

```js
describe("English duration units", () => {
  it("formats idle, lateness and break in English", () => {
    expect(formatIdle(65 * 60, "en")).toBe("1 h 5 min");
    expect(formatIdle(25 * 60, "en")).toBe("25 min");
    expect(formatLateness(5 * 60, "en")).toBe("5 min late");
    expect(formatBreak(20 * 60, "en")).toBe("20 min");
  });
});
```

(import `formatLateness`, `formatBreak` if not yet imported there). TopBar test (append):

```js
import { I18nProvider } from "../i18n.jsx";
it("switches the language from the top bar", () => {
  render(<I18nProvider locale="ar"><TopBar role="employee" onRole={() => {}} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "English" }));
  expect(screen.getByRole("button", { name: "عربي" })).toBeInTheDocument();
  expect(document.documentElement.dir).toBe("ltr");
});
```

(add `fireEvent` to its RTL import).

- [ ] **Step 2: Run** `cd web && npx vitest run` — new tests FAIL.

- [ ] **Step 3: Implement**

`web/src/i18n.jsx`:

```jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import ar from "./locales/ar.js";
import en from "./locales/en.js";

const DICTS = { ar, en };
const TITLE_MARK = "⚠️ ";

/** Text for `key` in `locale`, {name} placeholders filled; falls back to Arabic, then to the key. */
export function translate(locale, key, vars) {
  const s = DICTS[locale]?.[key] ?? ar[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : s;
}

const I18nContext = createContext({ locale: "ar", t: (k, v) => translate("ar", k, v), setLocale: () => {} });

/** Provides the language; keeps <html lang/dir> and the tab title in step with it. */
export function I18nProvider({ locale, onChange, children }) {
  const [current, setCurrent] = useState(locale === "en" ? "en" : "ar");
  useEffect(() => { setCurrent(locale === "en" ? "en" : "ar"); }, [locale]);
  useEffect(() => {
    const el = document.documentElement;
    el.lang = current;
    el.dir = current === "ar" ? "rtl" : "ltr";
    const marked = document.title.startsWith(TITLE_MARK);
    document.title = (marked ? TITLE_MARK : "") + translate(current, "app.title");
  }, [current]);
  const value = useMemo(() => ({
    locale: current,
    t: (k, v) => translate(current, k, v),
    setLocale: (next) => {
      if (next !== "ar" && next !== "en") return;
      setCurrent(next);
      onChange?.(next);
    },
  }), [current, onChange]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
```

`web/src/locales/ar.js` / `en.js` (start; later tasks add keys):

```js
// ar.js
export default {
  "app.title": "الدوام",
  "test.hello": "مرحباً، {name}",
  "lang.switch": "English",
};
// en.js
export default {
  "app.title": "TimeClock",
  "test.hello": "Hello, {name}",
  "lang.switch": "عربي",
};
```

(`lang.switch` shows the *other* language's name, so the English dictionary's value is the word "عربي" — the one allowed exception: in `i18n.test.jsx` change the "free of Arabic letters" filter to skip the key `lang.switch`.)

`time.js`: give `formatIdle`, `formatLateness`, `formatBreak` a `locale = "ar"` parameter and a unit map:

```js
const UNITS = {
  ar: { min: "د", h: "س", late: (d) => `متأخر ${d}` },
  en: { min: "min", h: "h", late: (d) => `${d} late` },
};
const unitsFor = (locale) => UNITS[locale] ?? UNITS.ar;
```

and build the strings from it (`${m} ${u.min}`, `${h} ${u.h} ${mm} ${u.min}`, `${h} ${u.h}`, `u.late(...)`), keeping every current Arabic output identical.

`App.jsx`: wrap the signed-in tree in `<I18nProvider locale={user.locale} onChange={(l) => api.current.put("/me/locale", { locale: l }).catch(() => {})}>` (the callback in a `useCallback` or `useRef` so it is stable). Move its Arabic strings (errors, loading, dev-login labels, skip link) to keys (`app.sessionExpired`, `app.checking`, `app.devMode`, `app.devEmployee`, `app.devManager`, `app.skip`) and read them with `translate(user?.locale ?? "ar", key)` where no provider is mounted yet.

`TopBar.jsx`: `const { locale, t, setLocale } = useI18n();` — add `<button type="button" className="btn ghost sm lang" onClick={() => setLocale(locale === "ar" ? "en" : "ar")}>{t("lang.switch")}</button>`; the date label uses `new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", { weekday: "long", day: "numeric", month: "long" })`; role-picker labels become keys (`topbar.view`, `topbar.employee`, `topbar.manager`).

`styles.css`: replace physical alignment with logical — every `text-align:right` → `text-align:start`; check the six rules found by `grep -n "text-align:right\|to left" web/src/styles.css` and add an `[dir="ltr"]` counterpart to the `[dir="rtl"] .seg-work.open` gradient (`to right`). Add `.lang{margin-inline-start:auto}`.

`web/index.html`: keep `dir="rtl" lang="ar"` (the provider sets the real values at runtime).

- [ ] **Step 4: Run** full web suite + build → **0 failed**, 135 + 7 = **142**; no act() warnings.
- [ ] **Step 5: Commit** `feat(i18n): language module, English formatters, top-bar language switch, direction-neutral CSS`.

---

### Task 3: Translate the employee side

**Files:** Modify `web/src/components/EmployeeScreen.jsx`, `MyHistory.jsx`, `StopNoteDialog.jsx`, their tests, `web/src/locales/ar.js`, `en.js`, `web/src/i18n.test.jsx` (extend `TRANSLATED_FILES` with `"components/EmployeeScreen.jsx", "components/MyHistory.jsx", "components/StopNoteDialog.jsx"`).

**Interfaces — Consumes:** `useI18n`, `formatIdle(sec, locale)`, `formatLateness`, `formatBreak` (Task 2).

- [ ] **Step 1: Failing tests** — extend `TRANSLATED_FILES` as above (the scan test now fails). In `EmployeeScreen.test.jsx` add:

```js
import { I18nProvider } from "../i18n.jsx";
it("speaks English inside an English provider", async () => {
  const api = makeApi({ open_session: null, worked_sec: 0, server_time: nowSec() });
  render(<I18nProvider locale="en"><ToastProvider><EmployeeScreen api={api} user={{ name: "Sara" }} /></ToastProvider></I18nProvider>);
  expect(await screen.findByRole("button", { name: /Clock in/ })).toBeInTheDocument();
  expect(screen.getByText("My hours this week")).toBeInTheDocument();
});
```

and in `StopNoteDialog.test.jsx` one test rendering it inside `<I18nProvider locale="en">` asserting its English confirm button text (use the key's English value you define, e.g. "Clock out").

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — in each file call `const { t, locale } = useI18n();`, replace every Arabic literal (JSX text, attributes like `aria-label`/`placeholder`/labels, toast messages, error-code maps) with `t("employee.…")` / `t("history.…")` / `t("stopNote.…")` keys, adding each key to **both** dictionaries (Arabic = the exact current text, English per the Glossary). Templates with values use placeholders (`t("employee.idleBanner", { time, dur })`). Pass `locale` to `formatIdle`/`formatLateness`/`formatBreak`. Rewrite Arabic comments in English. The error map becomes `t("err.<CODE>")` keys (shared `err.*` namespace, also used in Task 4; `err.generic` = "حدث خطأ، حاول مرة أخرى" / "Something went wrong, please try again").
- [ ] **Step 4: Run** full suite + build → 0 failed (142 + 2 = **144**); existing Arabic tests unchanged and passing.
- [ ] **Step 5: Commit** `feat(i18n): employee screens in Arabic and English`.

---

### Task 4: Translate the manager side, company language, time pickers

**Files:** Modify `ManagerDashboard.jsx`, `KpiRow.jsx`, `LiveFloor.jsx`, `ReportPanel.jsx`, `SessionEditModal.jsx`, `AlertsPanel.jsx`, `SettingsPanel.jsx`, their tests, both dictionaries, `i18n.test.jsx` (replace `TRANSLATED_FILES` with every non-test `.jsx` under `components/` plus `App.jsx`: build it with `readdirSync(new URL("./components/", import.meta.url)).filter((f) => f.endsWith(".jsx") && !f.includes(".test.")).map((f) => `components/${f}`)` and add `"App.jsx"`).

**Interfaces — Consumes:** Task 1 settings `locale`; Task 2 i18n + formatters; the `err.*` keys from Task 3.

- [ ] **Step 1: Failing tests**
  - `SettingsPanel.test.jsx`:

```js
it("uses time pickers for working hours and breaks", async () => {
  const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, break_mode: "fixed", break_start: "13:00", break_end: "14:00", work_end: "17:00" } : { installed: false })), put: vi.fn() };
  wrap(<SettingsPanel api={api} />);
  for (const label of ["بداية الدوام", "نهاية الدوام", "بداية الاستراحة", "نهاية الاستراحة"]) {
    expect(await screen.findByLabelText(label)).toHaveAttribute("type", "time");
  }
});
it("saves the company language", async () => {
  const api = { get: vi.fn(async (p) => (p === "/admin/settings" ? { ...BASE, locale: "ar" } : { installed: false })), put: vi.fn(async (_p, b) => b) };
  wrap(<SettingsPanel api={api} />);
  fireEvent.change(await screen.findByLabelText("لغة الشركة"), { target: { value: "en" } });
  fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
  await waitFor(() => expect(api.put.mock.calls[0][1].locale).toBe("en"));
});
```

  Existing SettingsPanel tests query labels like "بداية الاستراحة (HH:MM)" / "نهاية الدوام (HH:MM)" — update those queries to the new labels without "(HH:MM)".
  - `AlertsPanel.test.jsx`: one test inside `<I18nProvider locale="en">` expecting "Working without clocking in since 09:05" for a not-clocked-in alert (Dubai fixture as in the existing tests) and "No activity since 11:35 · 25 min" for an ongoing idle one.
  - `ReportPanel.test.jsx`: one English test expecting the column header "Late days".
- [ ] **Step 2: Run** → FAIL (scan test, new tests).
- [ ] **Step 3: Implement** — same method as Task 3 (`manager.*`, `live.*`, `report.*`, `edit.*`, `alerts.*`, `settings.*`, `err.*` keys; Glossary terms; pass `locale` to formatters; English comments). In `SettingsPanel.jsx`:
  - the four time fields become `<input id=… type="time" value={s.x ?? ""} onChange={set("x")} />` with labels "بداية الدوام" / "نهاية الدوام" / "بداية الاستراحة" / "نهاية الاستراحة" (English: Work start / Work end / Break start / Break end) — no "(HH:MM)";
  - a "لغة الشركة" / "Company language" `<select id="company-locale">` with options `ar` "العربية" and `en` "English" (option labels are each language's own name in both dictionaries — add `settings.langAr` with value "العربية" in both and treat it like `lang.switch` in the no-Arabic test's exception list), sent as `locale: s.locale ?? "ar"` in the PUT body;
  - error map adds `INVALID_LOCALE`.
  - Day names in the work-days fieldset come from `settings.day.<n>` keys.
- [ ] **Step 4: Run** full suite + build → 0 failed (144 + 5 = **149**); no Arabic left in any component (scan passes).
- [ ] **Step 5: Commit** `feat(i18n): manager screens in Arabic and English, company language, time pickers`.

---

### Task 5: Docs and full verification

- [ ] **Step 1:** unit 53/0; frontend 149/0; build OK; smoke dev 210/0; one production-mode smoke run (0 failed); restart normally. Also open the built app locally (`npm run build`, dev-login is only in development — run `cd web && npm run dev` with the API up) only if a manual look is needed; not required.
- [ ] **Step 2:** `CLAUDE.md` folder list: `src/i18n.jsx` (language provider + `t()`), `src/locales/` (ar/en dictionaries); UI rules: "Arabic (RTL) and English (LTR); all user-visible text comes from `src/locales/*`; Western digits in both". `docs/DECISIONS.md`: entry "2026-10-03 — Arabic + English" (home-made i18n instead of a library — ~170 strings, no dependency; company default + personal override; install pages by Accept-Language; time pickers; rejected: react-i18next, browser-language auto-detect for the app, per-location only). `docs/PROGRESS.md`: Current State + Session Log (migration 006 pending in production; not pushed).
- [ ] **Step 3: Commit** `docs: record Arabic + English`. Do not push.
