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
| `locale` | ENUM(`ar`,`en`) | `ar` | لغة الشركة (migration 006). لغة كل موظف بتتبعها إلا إذا اختار لغة خاصة فيه (`employees.locale`) |
| `daily_target_hours` | DECIMAL(4,2) | 8 | |
| `work_start` | CHAR(5) NULL | `09:00` | أول وقت العمل الرسمي. `NULL` = التأخير معطّل. لو محدد، أي جلسة أول جلسة بيومها المحلي وبلّشت بعد `work_start + late_grace_minutes` بتنعتبر متأخرة (شوف `/admin/report`، §5.1) |
| `work_end` | CHAR(5) NULL | `NULL` | نهاية الدوام `HH:MM` بتوقيت الحساب، لازم تكون بعد `work_start` (نفس اليوم). `NULL` = ما في نهاية دوام محددة |
| `work_days` | TINYINT UNSIGNED | 127 | bitmask أيام الدوام بتوقيت الحساب: bit 0 = الأحد … bit 6 = السبت (127 = كل الأيام، القيمة بين 1 و127) |
| `late_grace_minutes` | INT | 15 | سماحية بالدقايق قبل ما الجلسة تنعتبر متأخرة |
| `breaks_enabled` | TINYINT(1) | 0 | متزامن تلقائياً مع `break_mode = 'flexible'` — للتوافق مع كود قديم، مش مصدر الحقيقة بعد الآن (شوف `break_mode`) |
| `break_mode` | ENUM(`off`,`fixed`,`flexible`) | `off` | نوع الاستراحة: بدون / ثابتة يحددها المدير / مرنة بزر الموظف |
| `break_start` | CHAR(5) NULL | `NULL` | بداية النافذة الثابتة، `HH:MM` بتوقيت الحساب — إلزامية مع `fixed`، ولازم تكون بنفس اليوم وقبل `break_end` |
| `break_end` | CHAR(5) NULL | `NULL` | نهاية النافذة الثابتة، `HH:MM` بتوقيت الحساب — إلزامية مع `fixed` |
| `break_paid` | TINYINT(1) | 0 | إذا 1، الاستراحة الثابتة ما بتنخصم من وقت العمل |
| `break_policy_since` | BIGINT NULL | `NULL` | UNIX seconds لآخر مرة تغيّرت فيها سياسة الاستراحة (`break_mode` أو `break_start` أو `break_end` أو `break_paid`) — `PUT /admin/settings` بيحطها `now` بس لما وحدة من هدول تتغير، وإلا بتضل متل ما هي. أي نافذة ثابتة بلّشت **قبلها** ما بتنسجل أبداً (السياسة بتسري من لحظة الحفظ، مش على نوافذ سابقة). `NULL` = بدون قيد (حسابات ما غيّرت السياسة من بعد migration 003) |
| `activity_monitoring` | TINYINT(1) | 0 | مراقبة النشاط من GHL، مطفاية افتراضياً |
| `idle_minutes` | INT | 30 | حد الخمول بالدقائق (1–240)، بيستخدمه تنبيه الخمول (مرحلة ج) وشارة الخمول الحية |
| `activity_monitoring_since` | BIGINT NULL | `NULL` | UNIX seconds لوقت آخر تفعيل للمراقبة؛ الخمول ما بينحسب من قبله. `PUT /admin/settings` بيحطها `now` لما المراقبة تنتقل من مطفاية لمفعّلة |
| `note_on_stop` | ENUM(`off`,`optional`,`required`) | `off` | سياسة الملاحظة عند إنهاء الدوام |
| `max_session_hours` | DECIMAL(4,2) | 12 | حد الإغلاق التلقائي |
| `updated_at` | BIGINT | | |

### `employees`

| العمود | ملاحظة |
|---|---|
| `user_id` + `location_id` | PK مركّب (نفس الشخص ممكن يكون بأكتر من Sub-Account) |
| `name`, `email` | بيتحدثوا مع كل SSO |
| `role` | `manager` / `employee` — بيتحدث مع كل SSO |
| `locale` | `ar` / `en` / `NULL` — اللغة الشخصية (migration 006). `NULL` = بيتبع لغة الشركة. ما بيتغيّر مع SSO، بس عبر `PUT /me/locale`. اللغة الفعلية = الشخصية، وإلا لغة الشركة، وإلا `ar` |
| `is_active` | للتعطيل لاحقاً بدون حذف |

### `sessions`

| العمود | ملاحظة |
|---|---|
| `id` | UUID |
| `started_at`, `ended_at` | UNIX seconds، `ended_at = NULL` يعني الجلسة مفتوحة |
| `duration_sec` | بيتحسب عند الإغلاق. هاي المدة الكاملة (wall-clock)، **مش** وقت العمل — وقت العمل = `duration_sec − break_sec` وبيتحسب وقت القراءة، مش مخزّن (شوف تحت) |
| `closed_by` | `user` / `auto` / `admin` |
| `note` | VARCHAR(500) NULL — ملاحظة الموظف عند الإنهاء، بس إذا سياسة `note_on_stop` مش `off` (شوف تحت) |
| `activity_count`, `last_activity_at`, `longest_idle_sec` | ملخص النشاط للجلسة (INT / BIGINT / INT، كلها NULL). `NULL` = ما كانت في مراقبة |
| `open_flag` | **Generated column:** `1` إذا مفتوحة، `NULL` إذا مسكّرة |

**الحماية من الجلسات المكررة:** `UNIQUE (user_id, location_id, open_flag)`. لأن الـ UNIQUE بيسمح بعدد لا نهائي من `NULL`، النتيجة إنه مسموح جلسة مفتوحة وحدة بس لكل موظف. هاد بيحمي من الضغط مرتين أو فتح tab تاني على مستوى الداتابيز نفسها. (MySQL ما بيدعم partial index، لهيك استخدمنا هالحل.)

### `breaks`

استراحة موظف جوّا جلسة (زر Pause، شوف §9 رقم 6).

| العمود | ملاحظة |
|---|---|
| `id` | UUID |
| `session_id` | الجلسة اللي فيها الاستراحة |
| `location_id` | مكرّر من الجلسة، عشان الفهرسة والعزل بين العملاء بدون JOIN بكل استعلام |
| `kind` | ENUM(`employee`,`fixed`) — `employee` = زر الموظف، `fixed` = نافذة ثابتة انسجلت تلقائياً |
| `started_at`, `ended_at` | UNIX seconds، `ended_at = NULL` يعني الاستراحة مفتوحة |
| `open_flag` | **Generated column:** `1` إذا مفتوحة، `NULL` إذا مسكّرة |
| `fixed_key` | **Generated column:** `started_at` إذا `kind = 'fixed'`، وإلا `NULL` |

**الحماية من الاستراحات المكررة:** `UNIQUE (session_id, open_flag)` — نفس أسلوب `sessions`، استراحة مفتوحة وحدة بس لكل جلسة، محمي على مستوى الداتابيز. `UNIQUE (session_id, fixed_key)` — صف واحد بس لكل جلسة لكل نافذة ثابتة. وفوقها: **صف `fixed` واحد بس لكل جلسة لكل يوم محلي** (أول نافذة انسجلت هي اللي بتضل) — مفروض بالـ SQL نفسه (`INSERT … SELECT … WHERE NOT EXISTS` على حدود اليوم المحلي)، فحتى لو المدير غيّر النافذة بنفس اليوم ما بينخصم اليوم مرتين.

**حساب وقت العمل:** ما في عمود مخزّن لوقت العمل — بينحسب دائماً وقت القراءة كـ `duration_sec − break_sec`، ووقت كل استراحة **محصور (clipped) بحدود جلستها**: `LEAST(break.ended_at, session.ended_at) − GREATEST(break.started_at, session.started_at)`. هيك لو المدير قصّر جلسة بالتعديل اليدوي، أي استراحة فيها بتنقص معها تلقائياً بدل ما تصير أكبر من مدة الجلسة. استراحة شغالة (مفتوحة) بتنحسب لحظة القراءة بس (تقاس لـ `now`، مش أكتر).

**استراحة مفتوحة على جلسة مسكّرة:** لو جلسة سكّرت (إغلاق تلقائي `autoCloseStale`، أو تعديل مدير غيّر `ended_at`) وفيها استراحة لسا مفتوحة، `autoCloseStale` بتسكّر تلقائياً أي استراحة زي هيك على لحظة إغلاق جلستها — فما بضل في استراحة معلّقة أبداً.

**تعطيل الاستراحات:** زر الاستراحة بيشتغل بس لما `break_mode = 'flexible'` (`breaks_enabled` صار مجرد نسخة متزامنة للتوافق). لو المدير غيّر `break_mode` لـ `off` أو `fixed`، الموظف ما بيقدر يبلّش استراحة جديدة، **بس دائماً بيقدر ينهي استراحة شغالة عندو** — حتى ما يعلق فيها للأبد إذا المدير عطّلها وهو فيها.

### جداول ربط GHL ومراقبة النشاط (migration 004)

- `ghl_installs` — صف لكل Sub-Account: حالة تثبيت التطبيق (`installed_at` / `uninstalled_at`)، الـ tokens مشفّرة (`access_token_enc`, `refresh_token_enc`)، `scopes`، و`last_event_at` (آخر webhook وصل).
- `activity_events` — بيانات وصفية بس (النوع، المصدر، الوقت، `webhook_id` فريد لمنع التكرار)، **ولا محتوى** رسالة أو مكالمة. بتنحذف بعد 90 يوم.
- `activity_alerts` — تنبيهات الخمول `idle` (المرحلة ج) و"شغّال بدون تسجيل دخول" `working_not_clocked_in` (المرحلة ب). الفريدة `(session_id, idle_open_flag)` و`(location_id, user_id, nci_open_flag)` بتمنع تنبيه مفتوح مكرر؛ الأعمدة `*_open_flag` أرقام generated (مش نصوص) لأن MariaDB 11.8 رفض (ERROR 1901) IF() نصّي بعمود STORED.

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
| POST | `/auth/sso` | Body: `{ encryptedData }` → `{ token, user: { uid, loc, role, name, email, locale } }` — `locale` = اللغة الفعلية للمستخدم (`ar` أو `en`) |

### الموظف

| Method | Path | الوصف |
|---|---|---|
| GET | `/me/status?since=` | `{ open_session: {id, started_at, break_sec} \| null, open_break: {id, started_at} \| null, worked_sec, fixed_break: {starts_at, ends_at, paid} \| null, day_ends_at, activity_monitoring, server_time }`. `activity_monitoring` = هل مراقبة النشاط شغالة بهالحساب. `worked_sec` بدون الاستراحات. `since` افتراضياً **بداية اليوم بتوقيت الحساب** (نص الليل المحلي)، مش آخر 24 ساعة. `day_ends_at` = نص الليل الجاي بتوقيت الحساب (UNIX seconds)، والواجهة بترجع تجيب الأرقام عنده. `fixed_break` = نافذة اليوم إذا `break_mode = fixed` (و`null` إذا نافذة اليوم بلّشت قبل `break_policy_since`)؛ وإذا الجلسة المفتوحة عندها صف `fixed` منسجل اليوم، بيرجع هاد الصف (`paid: false`) لأنه هو اللي عم ينخصم فعلياً |
| GET | `/me/settings` | `{ daily_target_hours, timezone, work_start, note_on_stop, break_mode, break_start, break_end, break_paid, breaks_enabled }` — `breaks_enabled` قديم (legacy)، متزامن مع `break_mode = 'flexible'` |
| PUT | `/me/locale` | Body: `{ locale: "ar" \| "en" \| null }` — اللغة الشخصية؛ `null` = اتّبع لغة الشركة → `{ locale }` (اللغة الفعلية بعد الحفظ) · `400 INVALID_LOCALE` |
| POST | `/session/start` | `201 { id, started_at }` · `409 SESSION_ALREADY_OPEN` · بيسكّر تنبيه «عم يشتغل بدون دوام» المفتوح (`resolution = clocked_in`) |
| POST | `/session/stop` | Body اختياري: `{ note }` (حد أقصى 500 حرف). `200 { id, started_at, ended_at, duration_sec, break_sec, note }` — `duration_sec` المدة الكاملة، ووقت العمل = `duration_sec − break_sec`. إذا في استراحة مفتوحة بتسكّر معها. الملاحظة بتنحفظ بس إذا سياسة `note_on_stop` مش `off` · `400 NOTE_REQUIRED` · `400 NOTE_TOO_LONG` · `409 NO_OPEN_SESSION` |
| POST | `/session/break/start` | `201 { id, session_id, started_at }` · `403 BREAKS_DISABLED` · `409 NO_OPEN_SESSION` · `409 BREAK_ALREADY_OPEN` — مسموح بس لما `break_mode = flexible` |
| POST | `/session/break/stop` | `200 { id, started_at, ended_at, duration_sec }` · `409 NO_OPEN_BREAK` — مسموح حتى لو المدير لغى الاستراحات |
| GET | `/me/alerts` | تنبيهاتي المفتوحة: تنبيهات "بدون دوام" المفتوحة، وتنبيهات الخمول **الجارية** بس (`to_at` = null) → `{ alerts, timezone, server_time }` |
| POST | `/me/alerts/:id/note` | Body: `{ note }` (حد أقصى 300 حرف) — ملاحظة الموظف على تنبيهه المفتوح · `400 NOTE_REQUIRED` · `400 NOTE_TOO_LONG` · `404 ALERT_NOT_FOUND` |

### المدير (`role = manager` فقط، غير هيك `403 FORBIDDEN`)

| Method | Path | الوصف |
|---|---|---|
| GET | `/admin/live` | كل الموظفين مع الجلسة المفتوحة لكل واحد (المفتوحين أول شي)، ومع كل موظف `break_started_at` إذا هو باستراحة، و`fixed_break: {starts_at, ends_at, paid} \| null` (نافذة اليوم إذا `break_mode = fixed`)، و`idle_minutes` (`null` إذا المراقبة مطفية)، ومع كل موظف `last_activity_at` و`idle_sec` (ثواني بلا نشاط بالجلسة المفتوحة بدون الاستراحات؛ `null` إذا المراقبة مطفية أو ما وصل ولا حدث بآخر 24 ساعة) و`active_without_session` |
| GET | `/admin/report?from=&to=` | لكل موظف: `worked_sec`, `sessions_count`, `days_present`, `auto_closed` + `daily_target_hours`, `timezone` |
| GET | `/admin/sessions?from=&to=&user_id=` | قائمة الجلسات (حد أقصى 1000)، `user_id` اختياري، مع `break_sec` لكل جلسة، و`note`، و`activity_count` و`longest_idle_sec` (`null` = ما كانت مراقبة، أو ما وصل أي حدث للموقع خلال الـ24 ساعة قبل انتهاء الجلسة) |
| PATCH | `/admin/sessions/:id` | Body: `{ started_at, ended_at, reason }` — السبب إجباري |
| GET | `/admin/export.csv?from=&to=` | CSV مع BOM: Employee, Email, Start, End, Hours (بدون الاستراحات، وما بتنزل تحت 0), Break (min), Closed by, Note, Activity, Longest idle (min). الأوقات بالـ timezone تبع الحساب، وأي خلية بتبدأ بـ = + - @ بتنسبق بـ ' لحتى ما تشتغل كمعادلة |
| GET | `/admin/settings` | الإعدادات الحالية |
| GET | `/admin/ghl-connection` | حالة الربط مع GHL لهالحساب: `{ installed, has_activity_scope, last_event_at, events_24h, unknown_active_users }`. `unknown_active_users` = مستخدمين إلهم نشاط بآخر 7 أيام وما فتحوا TimeClock |
| GET | `/admin/alerts?status=` | تنبيهات النشاط: `status` = `open` (افتراضي) أو `resolved` أو `dismissed` → `{ alerts: [{ id, user_id, session_id, name, kind, from_at, to_at, status, resolution, employee_note, employee_note_at, detected_at, resolved_at }], timezone, server_time }` (الأحدث أول بحسب `from_at` ثم `id`، حد أقصى 200؛ `resolved_at` فاضي للتنبيه المفتوح؛ `kind` ممكن يكون `idle`: `from_at` = آخر نشاط، `to_at` = وقت رجوع النشاط أو نهاية الجلسة، و`null` إذا لسا جاري) · `400 INVALID_STATUS` |
| POST | `/admin/alerts/:id/dismiss` | تجاهل تنبيه مفتوح → `{ ok: true }` · `404 ALERT_NOT_FOUND` |
| PUT | `/admin/settings` | Body: `{ timezone, locale ("ar" أو "en"؛ الغايب = بيضل متل ما هو، و`null` = `ar`), daily_target_hours, max_session_hours, work_start, work_end (HH:MM أو null، لازم بعد work_start), work_days (1–127), late_grace_minutes, note_on_stop, break_mode, break_start, break_end, break_paid, activity_monitoring (boolean), idle_minutes (1–240، افتراضي 30) }` — `break_mode` واحد من `off`/`fixed`/`flexible` (افتراضي `off`)؛ مع `fixed` لازم `break_start` و `break_end` (`HH:MM`، البداية قبل النهاية)؛ `break_paid` boolean. إذا الـ body فيه `breaks_enabled: true` بدون `break_mode` بينحسب `flexible` (توافق مع النسخة القديمة). الحقل الناقص من الـ body بيضل متل ما هو (`null` أو `""` = فاضي أو القيمة الافتراضية). قبل الحفظ بيسجّل النوافذ الثابتة اللي بلّشت تحت السياسة الحالية، وإذا تغيّر `break_mode`/`break_start`/`break_end`/`break_paid` بيصير `break_policy_since = now`. وتفعيل المراقبة بيسجّل `activity_monitoring_since = now` |

كل دقيقة (وقبل `/admin/live` و`/admin/alerts` و`/me/alerts`) بيفحص السيرفر الجلسات المفتوحة ويفتح تنبيه `idle` إذا عدّى حد الخمول بلا نشاط (بدون الاستراحات، وبشرط وصل حدث للموقع بآخر 24 ساعة).

### من GHL (مش من مستخدم)

| Method | Path | الوصف |
|---|---|---|
| POST | `/webhooks/events` | أحداث GHL. التحقق **بس** بالتوقيع `X-GHL-Signature` (Ed25519، المفتاح العام تبع GHL). توقيع غلط → `401 WEBHOOK_BAD_SIGNATURE` (بينكتب سطر تحذير بدون محتوى، مرة بالدقيقة بالكثير). التوقيع بيثبت إنه من GHL مش إنه لتطبيقنا: GHL بتوقّع كل التطبيقات بنفس المفتاح، فإذا `GHL_APP_ID` مضبوط بيتجاهل (200 بدون كتابة) أي `INSTALL`/`UNINSTALL` `appId` تبعه مختلف أو ناقص. مفتاح الاختبار بينقبل بس لما `NODE_ENV` = `development` أو `test`. أي حدث موقّع صح بيرجع `200` (انخزّن أو انتجاهل) لحتى GHL ما يعيد الإرسال. `INSTALL`/`UNINSTALL` بيحدّثوا `ghl_installs`؛ `OutboundMessage` بينخزّن كـ `activity_events` (بيانات وصفية بس) إذا `activity_monitoring = 1`، ومرة وحدة لكل `messageId` (وإذا ما في، لكل `webhookId`). إذا الحدث فيه `userId` لموظف (`role = employee`) فتح TimeClock قبل، وصار جوّا ساعات الدوام (`work_start`…`work_end`، أيام `work_days`، بتوقيت الحساب)، وعمره أقل من 6 ساعات، وما عنده جلسة مفتوحة ولا جلسة انتهت بعد وقت الحدث (التسليم المتأخر أو المكرّر ما بيفتح تنبيه قديم) → بينفتح تنبيه `working_not_clocked_in` (واحد مفتوح بالكثير لكل موظف، بجملة SQL وحدة)؛ التسليم المكرّر (ما انخزّن) ما بيفتح شي. الحدث المحسوب بيسكّر فترة الخمول الجارية لهالموظف (`to_at`)، وإذا الفترة ما وصلت للحد بتنحل `late_activity`. الحدث اللي بيوصل بعد ما انتهت الفترة (بحدث أحدث أو بنهاية الجلسة) وتاريخه جوّاها بيقصّرها بنفس الطريقة، وبينحل `late_activity` إذا الباقي أقل من الحد. أكبر من 256KB → `413 PAYLOAD_TOO_LARGE` |
| GET | `/oauth/callback?code=` | رابط الرجوع بعد تثبيت التطبيق. بيبدّل الكود بتوكن من `services.leadconnectorhq.com/oauth/token` وبيخزّنه **مشفّر** (AES-256-GCM بـ `TOKEN_ENC_KEY`) بـ `ghl_installs`. بيرجّع صفحة بلغة المتصفح (`Accept-Language`: عربي إذا بدأ بـ `ar`، وإلا إنجليزي): `200` نجاح، `400` بدون كود، `503` السيرفر مش مُعدّ، `502` GHL رفض الكود، `504` ما قدرنا نوصل لـ GHL (مهلة 10 ثواني) |

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
| `INVALID_DAYS` | 400 | عدد الأيام خارج المدى (1–31) | صحّح القيمة |
| `SESSION_NOT_FOUND` | 404 | | |
| `ALERT_NOT_FOUND` | 404 | التنبيه مش موجود، أو مش مفتوح، أو مش إلك | التنبيه ما عاد موجود |
| `DEV_LOGIN_DISABLED` | 404 | dev-login مطلوب بالإنتاج | (تطوير فقط) |
| `INVALID_BREAKS` | 400 | `breaks_enabled` أو `break_paid` مش boolean | إعداد الاستراحات غير صحيح |
| `INVALID_NOTE_POLICY` | 400 | `note_on_stop` مش من القيم المسموحة | إعداد الملاحظة غير صحيح |
| `BREAKS_DISABLED` | 403 | المدير ما فعّل الاستراحات | الاستراحات غير مفعّلة |
| `INVALID_BREAK_MODE` | 400 | `break_mode` مش من القيم المسموحة | نوع الاستراحة غير صحيح |
| `INVALID_BREAK_WINDOW` | 400 | وقت الاستراحة الثابتة ناقص أو غلط أو النهاية قبل البداية | وقت الاستراحة غير صحيح |
| `BREAK_ALREADY_OPEN` | 409 | | أنت في استراحة بالفعل |
| `NO_OPEN_BREAK` | 409 | | لا توجد استراحة مفتوحة |
| `NOTE_REQUIRED` | 400 | المدير خلّى الملاحظة إلزامية | اكتب ملاحظة قبل إنهاء الدوام |
| `NOTE_TOO_LONG` | 400 | أكتر من 500 حرف (ملاحظة الإنهاء) أو 300 (ملاحظة التنبيه) | الملاحظة طويلة جداً |
| `INVALID_IDLE_MINUTES` | 400 | حد الخمول مش رقم صحيح بين 1 و240 | حد الخمول لازم يكون بين 1 و240 دقيقة |
| `INVALID_WORK_END` | 400 | نهاية الدوام مش `HH:MM` أو مش بعد البداية | نهاية الدوام غير صحيحة (لازم تكون بعد البداية) |
| `INVALID_WORK_DAYS` | 400 | أيام الدوام مش رقم صحيح بين 1 و127 | اختار يوم دوام واحد على الأقل |
| `INVALID_LOCALE` | 400 | اللغة مش `ar` أو `en` | اللغة غير صحيحة |
| `INVALID_STATUS` | 400 | `status` مش `open`/`resolved`/`dismissed` | — |
| `INVALID_ACTIVITY_MONITORING` | 400 | `activity_monitoring` مش boolean | إعداد مراقبة النشاط غير صحيح |
| `WEBHOOK_BAD_SIGNATURE` | 401 | حدث بدون توقيع GHL صحيح | — (مش للواجهة) |
| `PAYLOAD_TOO_LARGE` | 413 | جسم الحدث أكبر من 256KB | — (مش للواجهة) |
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
6. **الاستراحات:** زر استراحة حقيقي (Pause)، لا Stop/Start. بيشتغل بس إذا المدير اختار `break_mode = 'flexible'` بإعدادات الحساب (غير هيك `403 BREAKS_DISABLED`)، وبيسكّر وقت العمل مؤقتاً بدون ما يقفل الجلسة. وقت العمل المعروض والمحسوب بالتقارير = مدة الجلسة ناقص مجموع الاستراحات، وبيتحسب وقت القراءة (مش مخزّن). كل استراحة محصورة (clipped) بحدود جلستها — إذا المدير قصّر جلسة بالتعديل اليدوي، الاستراحة اللي فيها بتنقص معها تلقائياً. إذا جلسة سكّرت وفيها استراحة مفتوحة (إغلاق تلقائي أو تعديل مدير)، `autoCloseStale` بتسكّر الاستراحة بنفس لحظة إغلاق الجلسة. استراحة مفتوحة وحدة بس لكل جلسة — محمي على مستوى الداتابيز متل الجلسات (شوف §7). الموظف يقدر ينهي استراحته دائماً حتى لو المدير عطّل الاستراحات وهو فيها، حتى ما يعلق فيها للأبد.
7. الاستراحة الثابتة غير المدفوعة بتنخصم من أي جلسة بتغطي النافذة، حتى لو الموظف اشتغل وقتها؛ بتنسجل كصف `breaks` نوعه `fixed` أول ما تبلش النافذة لجلسة مفتوحة أو لما المدير يعدّل جلسة لتغطيها، فتغيير الإعدادات بعدين ما بيغيّر الأيام المسجلة؛ المدفوعة ما بتنخصم وبتنعرض للموظف بس. **صف ثابت واحد بس لكل جلسة لكل يوم محلي** — أول نافذة انسجلت هي اللي بتضل، فتغيير النافذة بنفس اليوم ما بيخصم مرتين. **تغيير السياسة بيسري من لحظة الحفظ** (`break_policy_since`) وأبداً مش على نوافذ أقدم: نافذة بلّشت قبل الحفظ ما بتنخصم، وتعديل مدير لجلسة بيوم قبل السياسة ما بيسجّل شي. قبل ما تتغير السياسة، `PUT /admin/settings` بيسجّل أول النوافذ اللي بلّشت تحت السياسة القديمة، وتعديل جلسة مفتوحة بيسجّل نافذتها الشغالة قبل التعديل. الاستراحات الثابتة المسجلة **ما بتنشال من الواجهة**.

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
8. متغيرات اختيارية لربط الـ OAuth ومراقبة النشاط (بدونها بيرجع `/oauth/callback` بـ `503`): `GHL_CLIENT_ID` و `GHL_CLIENT_SECRET` (من إعدادات التطبيق بالـ Marketplace)، `TOKEN_ENC_KEY` (64 حرف hex عشوائي، مثلاً `openssl rand -hex 32`)، و `GHL_REDIRECT_URI` (اختياري، الافتراضي `https://timeclock.noursky.com/oauth/callback`). وكمان `GHL_APP_ID` (رقم التطبيق بالـ Marketplace): **اضبطه بالإنتاج**، بدونه أي تطبيق تاني منصّب على نفس الـ Sub-Account بيقدر يعيد توجيه أحداثه الموقّعة لعندنا ويغيّر حالة الربط.

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
✅ خلص: زر Pause حقيقي للاستراحات (`breaks_enabled`)، حساب التأخير من `work_start` (+ `late_grace_minutes`)، وملاحظة عند إنهاء الدوام بسياسة `note_on_stop` (off/optional/required). باقي: تعطيل موظف، تحذير عند تعديل يخلق جلسات متداخلة.

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
