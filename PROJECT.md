# NourSky TimeClock — نظام تتبع دوام الموظفين داخل GoHighLevel

> **الحالة:** Backend جاهز ومُختبر محلياً · Frontend مبني ومُختبر بالوحدات · لسا ما صار deploy
> **آخر تحديث:** 19 September 2026
> **المالك:** NourSky Digital Agency

---

## الفهرس

1. [الفكرة](#1-الفكرة)
2. [المشكلة](#2-المشكلة)
3. [الهدف ونطاق العمل](#3-الهدف-ونطاق-العمل)
4. [القرارات المعمارية وليش أخدناها](#4-القرارات-المعمارية-وليش-أخدناها)
5. [الـ Architecture](#5-الـ-architecture)
6. [آلية الـ SSO خطوة بخطوة](#6-آلية-الـ-sso-خطوة-بخطوة)
7. [الـ Data Model](#7-الـ-data-model)
8. [الـ API Reference](#8-الـ-api-reference)
9. [قواعد العمل (Business Rules)](#9-قواعد-العمل-business-rules)
10. [مواصفات الواجهة (Frontend Spec)](#10-مواصفات-الواجهة-frontend-spec)
11. [هيكل المشروع والملفات](#11-هيكل-المشروع-والملفات)
12. [التشغيل المحلي](#12-التشغيل-المحلي)
13. [إعداد تطبيق GHL Marketplace](#13-إعداد-تطبيق-ghl-marketplace)
14. [النشر على Hostinger](#14-النشر-على-hostinger)
15. [الاختبار](#15-الاختبار)
16. [الجدول الزمني والمراحل](#16-الجدول-الزمني-والمراحل)
17. [المخاطر والأسئلة المفتوحة](#17-المخاطر-والأسئلة-المفتوحة)
18. [المهمة الجاية](#18-المهمة-الجاية)

---

## 1. الفكرة

ميزة جديدة بتنضاف لعملاء NourSky على GoHighLevel: كل موظف بالشركة بيفتح صفحة داخل الـ Sub-Account، بيضغط **Start** لما يبلّش شغل و **Stop** لما يخلص، والمدير بيشوف من داشبورد واحدة مين شغّال هلق، وكم ساعة اشتغل كل موظف، وأيام الحضور، مع إمكانية تصدير التقرير.

التجربة المستهدفة قريبة من ميزة الحضور بـ Bitrix24، بس جوّا GHL نفسه، بدون ما الموظف يطلع لأداة تانية.

**الشكل التجاري:** Feature بتتقدم للعميل كإضافة (add-on) على حسابه بـ GHL، وممكن لاحقاً تتحول لتطبيق عام على الـ Marketplace.

---

## 2. المشكلة

GHL **ما فيه** ميزة Clock In / Clock Out أصلية للموظفين لحد اليوم:

- في أكتر من طلب مفتوح على بوابة الأفكار الرسمية `ideas.gohighlevel.com` (مثلاً "Time Registration System" و "Staff Time Tracking")، والمستخدمين عم يطلبوها ويشتكوا إنها مش موجودة حتى بسنة 2026.
- الوكالات حالياً عم تستخدم أدوات برّا GHL (Hubstaff، Clockify) وتدفع عليها بشكل منفصل.
- الحلول الموجودة بالـ Marketplace متل FieldTask موجّهة لفرق ميدانية (صيانة، تنظيف، مقاولات) مع GPS، ومش مناسبة لموظفين مكتب أو فرق مبيعات.

**يعني في فجوة حقيقية بالسوق**، خصوصاً للعملاء الخليجيين اللي عندهم فرق sales وخدمة عملاء شغّالة من داخل GHL.

---

## 3. الهدف ونطاق العمل

### الهدف

إن مدير الشركة (العميل) يعرف بدقة وبشكل موثوق كم ساعة اشتغل كل موظف، بدون أداة خارجية، وبدون ما حدا يقدر يتلاعب بالتسجيل.

### نطاق v1 (Phase 1 — MVP)

| داخل النطاق | خارج النطاق (لاحقاً) |
|---|---|
| زر Start / Stop للموظف | GPS / Geofencing |
| عدّاد حي + مجموع ساعات اليوم والأسبوع | Screenshots / Activity monitoring |
| داشبورد مدير: مين شغّال هلق | Payroll |
| تقرير ساعات لكل موظف حسب فترة | إجازات (PTO) |
| تعديل جلسة من المدير مع سبب إجباري + Log | إشعارات تأخير |
| إغلاق تلقائي للجلسات المنسية | مؤشرات أداء من GHL API (Phase 3) |
| Export CSV | Billing / اشتراكات (Phase 4) |
| إعدادات لكل Sub-Account (timezone، هدف يومي، حد الجلسة) | |
| واجهة عربية RTL | |

### ملاحظة مهمة عن "الأداء"

الساعات **مش أداء**، هي حضور. موظف قاعد 8 ساعات بدون إنتاج رح يطلع أفضل من موظف أنجز بـ 5 ساعات. قياس الأداء الفعلي مخطط لـ Phase 3 عن طريق دمج الساعات مع بيانات GHL (tasks منجزة، محادثات، opportunities).

---

## 4. القرارات المعمارية وليش أخدناها

### 4.1 Private Marketplace App مع SSO (مش Custom Menu Link)

| الخيار | المشكلة / الميزة |
|---|---|
| Custom Menu Link مع `?userId=` بالـ URL | أسرع، بس الـ userId مكشوف وأي موظف فاهم تقنياً بيقدر يغيّره ويسجّل باسم غيره أو يفتح شاشة المدير. **مرفوض لنظام حضور.** |
| **Private Marketplace App + Custom Page + SSO** ✅ | GHL بيبعت هوية المستخدم مشفّرة بـ AES، والسيرفر بيفك التشفير بـ Shared Secret. الهوية والـ role موثوقين 100%، وما حدا بيقدر يزوّرهم. |

الفرق بالجهد بين الخيارين تقريباً يوم إلى يومين، ومقابلهن بياخد المنتج أمان حقيقي وقابلية للبيع بدون إعادة بناء.

**قيد معروف:** الـ SSO بـ GHL مدعوم **فقط** مع الـ Custom Pages، يعني الأداة بتفتح كصفحة من القائمة الجانبية، وما بتقدر تكون widget على الـ Dashboard الأساسي تبع GHL.

### 4.2 Hostinger Cloud (مش Cloudflare)

البداية كانت Cloudflare Worker + D1، وبعدين انتقلنا لـ **Hostinger Cloud Plan** لأنه الاستضافة الموجودة عند NourSky.

- Hostinger بيدعم Node.js Web Apps على خطط Business وكل خطط Cloud، مع deploy من GitHub أو zip.
- الداتابيز MySQL/MariaDB من hPanel.
- نسخة Cloudflare محفوظة بـ `archive/cloudflare-worker/` كمرجع فقط، **ما حدا يشتغل عليها.**

### 4.3 الـ Stack

| الطبقة | الاختيار | السبب |
|---|---|---|
| Runtime | Node.js >= 20 | مدعوم native على Hostinger |
| Framework | Hono + `@hono/node-server` | خفيف، Web-standard API، سهل ينتقل لأي runtime |
| Database | MySQL / MariaDB عبر `mysql2` | متوفر بـ hPanel |
| Language | JavaScript (ESM) بدون build step | بيقلل احتمال فشل الـ build على Hostinger |
| Frontend | React + Vite (مخطط) | خبرة الفريق، وبيتبنى ويتخدم static من نفس السيرفر |
| Auth | GHL SSO → توكن HMAC خاص فينا (12 ساعة) | ما منفك تشفير الـ SSO مع كل request |

### 4.4 التوقيت

كل الأوقات بتنخزن **UNIX seconds (UTC)**. التحويل للـ timezone تبع الـ Sub-Account بيصير بالعرض فقط. هيك ما في لخبطة بين عملاء بمناطق زمنية مختلفة.

---

## 5. الـ Architecture

```
┌──────────────────────── GHL Sub-Account ────────────────────────┐
│                                                                  │
│   القائمة الجانبية → "الدوام" (Custom Page من التطبيق)          │
│        │                                                         │
│        ▼                                                         │
│   ┌──────────────── iframe ─────────────────┐                   │
│   │  React App (RTL)                         │                   │
│   │  1. postMessage REQUEST_USER_DATA ──────┼──► GHL parent      │
│   │  2. ◄── encrypted payload ──────────────┼──                  │
│   └────────────────┬─────────────────────────┘                   │
└────────────────────┼─────────────────────────────────────────────┘
                     │ POST /auth/sso {encryptedData}
                     ▼
┌──────────────── Hostinger (Node.js App) ────────────────┐
│  Hono API                                                │
│   ├─ decryptSSO (AES-256-CBC, Shared Secret)             │
│   ├─ signToken (HMAC-SHA256, 12h)                        │
│   ├─ /me/*  /session/*  /admin/*                         │
│   ├─ autoCloseStale (timer + lazy قبل كل قراءة)          │
│   └─ static: React build (مخطط)                         │
│                     │                                    │
│                     ▼                                    │
│  MySQL / MariaDB: settings · employees · sessions ·      │
│                   edits_log                              │
└──────────────────────────────────────────────────────────┘
```

---

## 6. آلية الـ SSO خطوة بخطوة

1. المستخدم بيفتح صفحة التطبيق من القائمة الجانبية داخل الـ Sub-Account.
2. GHL بيحمّل الـ Custom Page جوّا iframe.
3. الواجهة بتبعت `postMessage` للـ parent بتطلب بيانات المستخدم.
4. GHL بيرجّع payload مشفّر (صيغة CryptoJS AES بالـ passphrase، بيبدأ بـ `Salted__`).
5. الواجهة بتبعت الـ payload كما هو لـ `POST /auth/sso`.
6. السيرفر بيفك التشفير بالـ `GHL_SHARED_SECRET` (OpenSSL `EVP_BytesToKey` بـ MD5 → key 32 byte + IV 16 byte → AES-256-CBC).
7. السيرفر بيطلع منه: `userId`, `role`, `type`, `activeLocation`, `userName`, `email`.
8. بيعمل upsert للموظف، وبيضمن وجود صف settings للـ location.
9. بيرجّع توكن خاص فينا موقّع بـ HMAC، والواجهة بتستخدمه بـ `Authorization: Bearer` لكل الطلبات التانية.

**تحديد الـ role:**

```
role === "admin"  أو  type === "agency"   →  manager
غير هيك                                  →  employee
```

**إذا ما في `activeLocation`** (يعني المستخدم فاتح من مستوى الـ Agency مش من Sub-Account) → `403 OPEN_FROM_SUB_ACCOUNT`.

> ⚠️ أسماء الحقول بالـ payload مأخوذة من توثيق GHL، ولازم تتأكد على حساب حقيقي أول ما يصير الربط (شوف القسم 17).

---

## 7. الـ Data Model

الملف: `schema.sql` (MySQL 8 / MariaDB 10.2+، `utf8mb4`).

### `settings` — صف واحد لكل Sub-Account

| العمود | النوع | الافتراضي | ملاحظة |
|---|---|---|---|
| `location_id` | VARCHAR(64) PK | | |
| `timezone` | VARCHAR(64) | `Asia/Riyadh` | IANA timezone |
| `daily_target_hours` | DECIMAL(4,2) | 8 | |
| `work_start` | CHAR(5) | `09:00` | محجوز لحساب التأخير لاحقاً |
| `max_session_hours` | DECIMAL(4,2) | 12 | حد الإغلاق التلقائي |
| `updated_at` | BIGINT | | |

### `employees`

| العمود | ملاحظة |
|---|---|
| `user_id` + `location_id` | PK مركّب (نفس الشخص ممكن يكون بأكتر من Sub-Account) |
| `name`, `email` | بيتحدثوا مع كل SSO |
| `role` | `manager` / `employee` — بيتحدث مع كل SSO |
| `is_active` | للتعطيل لاحقاً بدون حذف |

### `sessions`

| العمود | ملاحظة |
|---|---|
| `id` | UUID |
| `started_at`, `ended_at` | UNIX seconds، `ended_at = NULL` يعني الجلسة مفتوحة |
| `duration_sec` | بيتحسب عند الإغلاق |
| `closed_by` | `user` / `auto` / `admin` |
| `open_flag` | **Generated column:** `1` إذا مفتوحة، `NULL` إذا مسكّرة |

**الحماية من الجلسات المكررة:** `UNIQUE (user_id, location_id, open_flag)`. لأن الـ UNIQUE بيسمح بعدد لا نهائي من `NULL`، النتيجة إنه مسموح جلسة مفتوحة وحدة بس لكل موظف. هاد بيحمي من الضغط مرتين أو فتح tab تاني على مستوى الداتابيز نفسها. (MySQL ما بيدعم partial index، لهيك استخدمنا هالحل.)

### `edits_log`

كل تعديل من المدير على جلسة بيتسجل: مين عدّل، القيم القديمة والجديدة، السبب، والوقت. **بدونه ما في مصداقية للأرقام.**

---

## 8. الـ API Reference

كل الطلبات (ما عدا `/health` و `/auth/sso`) بتحتاج: `Authorization: Bearer <token>`.
كل الأوقات بالـ query والـ body هي UNIX seconds.
الأخطاء دائماً بالشكل: `{ "error": "ERROR_CODE" }`.

### عام

| Method | Path | الوصف |
|---|---|---|
| GET | `/health` | بيفحص الاتصال بالداتابيز → `{ ok, time }` |
| POST | `/auth/sso` | Body: `{ encryptedData }` → `{ token, user: { uid, loc, role, name, email } }` |

### الموظف

| Method | Path | الوصف |
|---|---|---|
| GET | `/me/status?since=` | `{ open_session: {id, started_at} \| null, worked_sec, server_time }`. `since` افتراضياً آخر 24 ساعة. |
| POST | `/session/start` | `201 { id, started_at }` · `409 SESSION_ALREADY_OPEN` |
| POST | `/session/stop` | `200 { id, started_at, ended_at, duration_sec }` · `409 NO_OPEN_SESSION` |

### المدير (`role = manager` فقط، غير هيك `403 FORBIDDEN`)

| Method | Path | الوصف |
|---|---|---|
| GET | `/admin/live` | كل الموظفين مع الجلسة المفتوحة لكل واحد (المفتوحين أول شي) |
| GET | `/admin/report?from=&to=` | لكل موظف: `worked_sec`, `sessions_count`, `days_present`, `auto_closed` + `daily_target_hours`, `timezone` |
| GET | `/admin/sessions?from=&to=&user_id=` | قائمة الجلسات (حد أقصى 1000)، `user_id` اختياري |
| PATCH | `/admin/sessions/:id` | Body: `{ started_at, ended_at, reason }` — السبب إجباري |
| GET | `/admin/export.csv?from=&to=` | CSV مع BOM (لحتى الـ Excel يقرأ العربي صح)، الأوقات بالـ timezone تبع الحساب |
| GET | `/admin/settings` | الإعدادات الحالية |
| PUT | `/admin/settings` | Body: `{ timezone, daily_target_hours, max_session_hours, work_start }` |

### رموز الأخطاء

| Code | Status | المعنى | رسالة مقترحة للواجهة |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | توكن ناقص أو مزوّر | انتهت الجلسة، أعد فتح الصفحة |
| `TOKEN_EXPIRED` | 401 | مرّ 12 ساعة | انتهت الجلسة، أعد فتح الصفحة |
| `SSO_BAD_FORMAT` | 400 | الـ payload مش بالصيغة المتوقعة | تعذّر التحقق من هويتك |
| `SSO_DECRYPT_FAILED` | 401 | Shared Secret غلط | تعذّر التحقق من هويتك |
| `OPEN_FROM_SUB_ACCOUNT` | 403 | فاتح من مستوى الـ Agency | افتح الأداة من داخل حساب الشركة |
| `FORBIDDEN` | 403 | موظف عم يطلب endpoint مدير | ليس لديك صلاحية |
| `SESSION_ALREADY_OPEN` | 409 | | أنت مسجّل دخول بالفعل |
| `NO_OPEN_SESSION` | 409 | ممكن تكون تسكّرت تلقائياً | لا توجد جلسة مفتوحة |
| `REASON_REQUIRED` | 400 | | سبب التعديل مطلوب |
| `INVALID_TIMES` | 400 | النهاية قبل البداية أو بالمستقبل | الأوقات غير صحيحة |
| `INVALID_RANGE` | 400 | `to <= from` | |
| `INVALID_TIMEZONE` / `INVALID_HOURS` / `INVALID_WORK_START` | 400 | | |
| `INVALID_GRACE` | 400 | سماح التأخير خارج المدى (0–240 دقيقة) | صحّح القيمة |
| `SESSION_NOT_FOUND` | 404 | | |
| `DEV_LOGIN_DISABLED` | 404 | dev-login مطلوب بالإنتاج | (تطوير فقط) |
| `INTERNAL_ERROR` | 500 | | حدث خطأ، حاول مرة أخرى |

---

## 9. قواعد العمل (Business Rules)

1. **جلسة مفتوحة وحدة** لكل موظف بكل Sub-Account، ومحمية على مستوى الداتابيز.
2. **العزل بين العملاء:** الـ `location_id` دائماً جاي من التوكن (يعني من الـ SSO)، وأبداً مش من الواجهة. عميل ما بيقدر يشوف بيانات عميل تاني.
3. **الإغلاق التلقائي:** أي جلسة تجاوزت `max_session_hours` بتتسكّر عند الحد بالضبط، وبتتعلّم `closed_by = 'auto'` لتظهر للمدير كجلسة بدها مراجعة. بيشتغل بطريقتين:
   - Timer داخلي كل 15 دقيقة لكل الحسابات.
   - **Lazy:** قبل أي قراءة أو start/stop للحساب المعني. هيك الأرقام بتضل صحيحة حتى لو Hostinger وقّف الـ process.
4. **حساب الساعات بالتقارير** بيقص الجلسات اللي بتقطع حدود الفترة (مثلاً جلسة بلّشت آخر الليل وخلصت تاني يوم بتنحسب صح لكل يوم).
5. **التعديل اليدوي:** للمدير فقط، سبب إجباري، النهاية لازم تكون بعد البداية ومش بالمستقبل، وكل تعديل بيتسجل بـ `edits_log`.
6. **الاستراحات بـ v1:** Stop ثم Start. زر Pause مؤجّل.

---

## 10. مواصفات الواجهة (Frontend Spec)

### متطلبات عامة

- React + Vite، بتتبنى لـ `public/` وبتتخدم static من نفس سيرفر Hono، **بدون CORS**.
- عربي RTL افتراضياً (`dir="rtl"`)، والأرقام بالشكل الإنجليزي `1, 2, 3`.
- خفيفة، لأنها بتشتغل جوّا iframe بـ GHL.
- الهوية البصرية: Accent بنفسجي `#6C5CE7`، عناوين فرعية وردي `#E91E63`، نص `#20203A`، ثانوي `#5A5A72`، خلفيات `#F4F0FF` و `#F7F7FB`، إيجابي `#1E7F4F`، سلبي `#C0392B`، تنبيه `#B8860B`.

### الـ SSO Handshake بالواجهة (مرجعي، لازم يتأكد مع توثيق GHL)

```js
function getGhlSso() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSO_TIMEOUT")), 5000);
    window.addEventListener("message", function handler({ data }) {
      if (data?.message === "REQUEST_USER_DATA_RESPONSE") {
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(data.payload);
      }
    });
    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
  });
}

const encryptedData = await getGhlSso();
const { token, user } = await fetch("/auth/sso", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ encryptedData }),
}).then((r) => r.json());
```

التوكن بيضل بالـ memory (React state)، **مش** بالـ localStorage. عند `401` بنعيد الـ handshake مرة وحدة تلقائياً.

### شاشة الموظف

- زر كبير: **ابدأ الدوام** / **إنهاء الدوام** حسب الحالة.
- عدّاد حي للجلسة الحالية (بيعتمد على `server_time` لتجنب فرق ساعة جهاز الموظف).
- مجموع ساعات اليوم ومجموع الأسبوع.
- حالة loading على الزر لمنع الضغط المتكرر.

### داشبورد المدير

1. **شغّال هلق:** قائمة الموظفين مع مؤشر أخضر للمسجّلين ومدة الجلسة، تحديث كل 30 ثانية.
2. **التقرير:** فلتر فترة (اليوم / الأسبوع / الشهر / مخصص)، جدول: الموظف، الساعات، الهدف (`أيام الحضور × الهدف اليومي`)، نسبة الإنجاز ملوّنة (أخضر / كهرماني / أحمر)، أيام الحضور، عدد الجلسات المسكّرة تلقائياً.
3. **تفاصيل موظف:** جلساته مع إمكانية التعديل (Modal فيه البداية والنهاية والسبب).
4. **تصدير CSV.**
5. **الإعدادات:** timezone، الهدف اليومي، حد الجلسة، وقت بداية الدوام.

---

## 11. هيكل المشروع والملفات

```
noursky-timeclock/
├── CLAUDE.md                  # تعليمات مختصرة لـ Claude Code
├── PROJECT.md                 # هالملف — المرجع الكامل
├── package.json               # start + test:smoke
├── .env.example               # كل متغيرات البيئة المطلوبة
├── .gitignore
├── schema.sql                 # MySQL/MariaDB schema — بيتنفذ مرة وحدة
├── src/
│   └── server.js              # الـ API كامل (Hono + mysql2)
├── scripts/
│   └── smoke-test.mjs         # اختبار end-to-end (20 حالة) بيحاكي SSO تبع GHL
├── web/                       # (لسا ما انعمل) React + Vite
└── archive/
    └── cloudflare-worker/     # النسخة الأولى على Cloudflare — مرجع فقط
        ├── src/index.ts
        ├── schema.sql
        ├── wrangler.toml
        └── tsconfig.json
```

### شرح `src/server.js`

| القسم | الوظيفة |
|---|---|
| Config | قراءة الـ env والتوقف فوراً إذا في متغير ناقص، إنشاء الـ pool وضبط `time_zone = '+00:00'` |
| `decryptSSO` | فك تشفير payload تبع GHL |
| `signToken` / `verifyToken` | توكن HMAC مع مقارنة `timingSafeEqual` |
| `authed` / `managerOnly` | Middlewares |
| `WORKED_EXPR` | معادلة SQL لحساب الثواني ضمن فترة مع قص الأطراف |
| `autoCloseStale` | الإغلاق التلقائي |
| Routes | كل الـ endpoints بالقسم 8 |
| Boot | تشغيل الـ timer والسيرفر على `PORT` |

---

## 12. التشغيل المحلي

```bash
# 1. داتابيز محلية (MariaDB أو MySQL)
mysql -e "CREATE DATABASE timeclock CHARACTER SET utf8mb4;"
mysql timeclock < schema.sql

# 2. المتغيرات
cp .env.example .env    # وعبّي القيم

# 3. التشغيل
npm install
node --env-file=.env src/server.js

# 4. الاختبار (بتيرمنال تاني)
BASE_URL=http://localhost:3000 GHL_SHARED_SECRET=<نفس القيمة بالـ .env> npm run test:smoke
```

> `npm start` ما بيقرأ `.env` تلقائياً، لأنه على Hostinger المتغيرات بتنحط من الـ hPanel. محلياً استخدم `--env-file`.

---

## 13. إعداد تطبيق GHL Marketplace

1. ادخل على `marketplace.gohighlevel.com` بحساب المطوّر → **Create App**.
2. **App Type:** Private · **Distribution:** Sub-Account.
3. **Custom Page:** رابط التطبيق على Hostinger (مثلاً `https://timeclock.noursky.com`).
4. **Advanced Settings → Auth → Shared Secret → Generate** → انسخه لـ `GHL_SHARED_SECRET`.
5. الـ Scopes: بـ Phase 1 ما منحتاج أي API scope (كل شي من الـ SSO). بـ Phase 3 منضيف scopes القراءة (users, tasks, conversations, opportunities).
6. ثبّت التطبيق على Sub-Account تجريبي أولاً، بعدين على حساب العميل.
7. اسم العنصر بالقائمة: مثلاً **"الدوام"**.

---

## 14. النشر على Hostinger

1. **hPanel → Databases → MySQL Databases:** اعمل database و user، واعطيه كل الصلاحيات.
2. **phpMyAdmin → Import:** ارفع `schema.sql`.
3. **Websites → Add Website → Deploy Web App:** اربط GitHub repo، Framework: **Other**، Start command: `npm start`.
4. **Environment variables:** كل اللي بـ `.env.example`. الـ `DB_HOST` غالباً `localhost`، تأكد منه بصفحة الداتابيز. `SESSION_SECRET` لازم يكون 32 حرف عشوائي على الأقل.
5. اربط الدومين (مثلاً `timeclock.noursky.com`) وتأكد من الـ SSL.
6. افتح `/health` → لازم يرجع `{ "ok": true }`.
7. شغّل الـ smoke test على السيرفر الحقيقي: `BASE_URL=https://timeclock.noursky.com GHL_SHARED_SECRET=... npm run test:smoke`. بيستخدم location_id عشوائي فما بيلمس بيانات عملاء.

---

## 15. الاختبار

### شو انختبر (محلياً على MariaDB 10.11 + Node 22)

**20/20 نجحوا:**
health · SSO موظف → employee · SSO admin → manager · secret غلط مرفوض · فتح من Agency بدون Sub-Account مرفوض · start → 201 · start مرتين → 409 · status بيظهر الجلسة · موظف ممنوع من شاشة المدير · المدير بيشوف القائمة · stop مع مدة · stop مرتين → 409 · التقرير بيحسب الساعات · قائمة الجلسات · تعديل بدون سبب → 400 · تعديل مع سبب → 200 · تحديث الإعدادات · timezone غلط → 400 · CSV فيه اسم عربي · توكن مزوّر → 401

**واختبارات يدوية إضافية:** الإغلاق التلقائي لجلسة منسية (تسكّرت عند الحد وتعلّمت `auto`)، وتخزين العربي صح بـ `utf8mb4` (تأكدنا بالـ HEX).

### شو لسا ما انختبر

- الـ deploy الفعلي على Hostinger.
- الـ SSO الحقيقي من داخل GHL (شكل الـ payload وأسماء الـ messages).
- الأداء مع حجم بيانات كبير.

---

## 16. الجدول الزمني والمراحل

### Phase 1 — MVP (التقدير: 6.5 إلى 8.5 أيام عمل)

| المهمة | الوقت | الحالة |
|---|---|---|
| Backend + Schema + SSO + Auto-close | 1.5 يوم | ✅ خلص |
| النقل من Cloudflare لـ Hostinger/MySQL | 0.5 يوم | ✅ خلص |
| Smoke test | — | ✅ خلص |
| إعداد تطبيق GHL + ربط الـ Custom Page | 0.5 يوم | ⏳ |
| واجهة React RTL (موظف + مدير + إعدادات) | 2.5 إلى 3 أيام | ✅ خلص |
| خدمة الواجهة static من Hono | 0.25 يوم | ✅ خلص |
| Deploy على Hostinger + اختبار حقيقي داخل GHL | 1.5 إلى 2 يوم | ⏳ |

### Phase 2 — تحسينات
زر Pause للاستراحات، حساب التأخير من `work_start`، تعطيل موظف، تحذير عند تعديل يخلق جلسات متداخلة.

### Phase 3 — الأداء الفعلي
سحب بيانات من GHL API لكل user (tasks منجزة، محادثات، مكالمات، opportunities) ودمجها مع الساعات بمؤشرات متل "إنجاز لكل ساعة عمل".

### Phase 4 — تحويله لمنتج
Onboarding لكل Sub-Account، billing، وإمكانية نشره كتطبيق عام على الـ Marketplace.

---

## 17. المخاطر والأسئلة المفتوحة

| البند | الأثر | الإجراء |
|---|---|---|
| أسماء حقول الـ SSO payload (`activeLocation`, `role`, `type`) وأسماء الـ postMessage | إذا اختلفت، الـ login ما بيشتغل | أول اختبار على Sub-Account حقيقي: اطبع الـ payload بعد فك التشفير وقارن |
| قيم الـ `role` لمستخدمي الـ Sub-Account | ممكن مدير العميل ما يطلع `admin` | تأكد من إعدادات المستخدمين عند العميل، ولو لزم منضيف جدول صلاحيات يدوي |
| الـ `PORT` على Hostinger | التطبيق ما بيقلع | الكود بيقرأ `process.env.PORT`، تأكد من الـ runtime logs |
| الـ process بيوقف على Hostinger | الـ timer ما بيشتغل | محلولة بالإغلاق الـ Lazy |
| `days_present` بيستخدم offset الـ timezone الحالي | خطأ بسيط بالمناطق اللي فيها توقيت صيفي | الخليج ما عنده DST، مقبول بـ v1 |
| تعديل المدير ممكن يخلق جلسات متداخلة | ساعات محسوبة مرتين | Phase 2: تحقق من التداخل قبل الحفظ |
| إصدار MySQL عند Hostinger | الـ generated column بدها MySQL 5.7+ أو MariaDB 10.2+ | تأكد من الإصدار بـ phpMyAdmin |

---

## 18. المهمة الجاية

**بناء واجهة React داخل `web/` حسب القسم 10**، وتعديل السيرفر ليخدم الـ build من `public/`:

1. ✅ خلص — `web/` بـ Vite + React، الـ build output بيروح لـ `../public`.
2. ✅ خلص — `src/server.js`: إضافة `serveStatic` من `@hono/node-server/serve-static` لـ `public/` مع fallback لـ `index.html`. الـ API routes لازم تنسجل **قبل** الـ static.
3. ✅ خلص — `package.json`: إضافة `"build": "cd web && npm install && npm run build"` لحتى Hostinger يبني الواجهة وقت الـ deploy.
4. ✅ خلص — للتطوير المحلي بدون GHL: وضع dev بيسمح بتسجيل دخول وهمي **فقط** إذا `NODE_ENV !== 'production'`.

Dev login: POST /auth/dev-login (NODE_ENV != production فقط).
