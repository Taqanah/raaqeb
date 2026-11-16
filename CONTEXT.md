# Raaqeb

Raaqeb (راقب, "keep watch over") is a self-hosted, single-tenant monitoring and status page tool. This glossary fixes the words the project uses. `docs/adr/` holds the decisions that are hard to reverse.

Each entry says what a word means, not how the code does it. Entries are alphabetical within a section; add yours in place.

## Language

### Install and people

**API key**:
Arabic: مفتاح الواجهة البرمجية
A secret an operator makes for their own account so a program can call the management API in their name, with a role no wider than the account's and an optional expiry.
_Avoid_: token (the metrics token and the path tokens are others), API token, access token, secret (the install key's word), password

**Audit entry**:
Arabic: مُدخل في سجل التدقيق; the page is سجل التدقيق
One record of who did what to what, from which address and when: a change an operator made in the admin area, a sign-in, or a refused sign-in and why it was refused. It keeps what was asked, never a secret. Entries are only added, read by owners and admins, and kept for the install's retention.
_Avoid_: activity feed, history (that is a monitor's checks), event (that is a monitor's change of state), log (alone: that is the server's output)

**Authenticator app**:
Arabic: تطبيق الاستيثاق
An app on an operator's phone that shows a new six-digit code every 30 seconds from a secret it shares with the install.
_Avoid_: TOTP in UI copy, authenticator (alone), token generator, 2FA app

**Backup code**:
Arabic: رمز احتياطي
One of a set of codes shown once when the authenticator app is set up, each good for one sign-in in place of the app's code.
_Avoid_: recovery code, one-time code (that is the emailed one), spare code

**Deactivated**:
Arabic: معطّل
An operator account that cannot sign in but is kept, with its role and name, so it can be reactivated. Removing an account is the other way to end its access, for good.
_Avoid_: banned, suspended, disabled (in copy), paused (that is a monitor's state)

**Getting-started checklist**:
Arabic: خطوات البدء
The card above the monitors list that names the four things a new install needs: a monitor, a component linked to a monitor, a published status page and a notification channel. Once closed, by all four existing or by the operator dismissing it, it never comes back.
_Avoid_: setup wizard, tour, onboarding (that ends when the account exists), setup check (that compares what the server sees with the configuration)

**Identity provider**:
Arabic: مزوّد الهوية
The OpenID Connect service an organisation signs its people in with (Keycloak, Authentik, Okta, Entra ID, Google Workspace), which single sign-on sends the browser to and trusts for who someone is.
_Avoid_: IdP (in copy), auth server, SSO provider

**Install**:
Arabic: تثبيت
One running Raaqeb serving one organization. Owns all monitors, channels, components, incidents and status pages.
_Avoid_: instance, tenant, workspace, account

**Invitation**:
Arabic: دعوة
An owner's or admin's offer of an operator account with one role to one email address: a single-use link that expires, accepted by setting a password or by signing in through the identity provider with that address.
_Avoid_: invite code, sign-up link, magic link

**Management API**:
Arabic: الواجهة البرمجية للإدارة
The JSON API under `/api/v1/`, called with an API key, through which a program changes monitors, groups, status pages, components, incidents, maintenance and channels under the same permissions and input rules as the admin area.
_Avoid_: admin API, private API, REST API (say the management API), the API (alone: the public read endpoints are an API too)

**Onboarding**:
Arabic: مرحلة الإعداد
The state of an install before any operator account exists, when Raaqeb serves only the onboarding pages. It ends when the first account, its owner, is created.
_Avoid_: first run, setup mode, installation (that is putting the binary on the server)

**One-time code**:
Arabic: رمز مؤقت
A short-lived code emailed to an operator for the second step. The authenticator app's codes and backup codes are not one-time codes, and password recovery uses a reset link, not a code.
_Avoid_: OTP in UI copy, token (in auth copy; the design component that isolates machine tokens keeps its name), PIN

**Operator**:
Arabic: مشغّل
A signed-in human who manages the install, with what their role allows.
_Avoid_: user (ambiguous with visitors), member, staff

**Operator account**:
Arabic: حساب المشغّل
An identity that can sign in to the admin area, by email and password or through single sign-on, with one role and the operator's own preferences. Onboarding makes the first, an owner; the others come from an invitation or the identity provider.
_Avoid_: admin user, root, superuser, user, member

**Reset link**:
Arabic: رابط إعادة التعيين
A one-time link, valid for a limited time, that opens the set-new-password page: emailed by "forgot password", or printed by the reset command when there is no email.
_Avoid_: magic link (that is a sign-in mechanism Raaqeb does not offer), reset token in UI copy

**Role**:
Arabic: دور (الجمع: أدوار). Roles: مالك، مدير، محرّر، مستجيب، مشاهد.
What an operator account may do, one of five, each allowing everything the next one does: a viewer reads the admin area; a responder also runs "check now", acknowledges outages, writes incidents and schedules maintenance; an editor also changes monitors, status pages and components and deletes incidents; an admin also changes notification channels and settings, reads the audit log and manages every account but an owner's; an owner also gives and takes the owner role, exports and imports, and sets how operators sign in. Every operator, whatever the role, changes their own account. An install always has at least one owner who is not deactivated. Whatever can redirect sign-in mail, change the public address or open a reset link belongs to the owner role.
_Avoid_: permission level, access level, group, admin (alone, for the area)

**Second step**:
Arabic: استيثاق ثنائي for the setting (الاستيثاق الثنائي مفعّل); الخطوة الثانية for the sign-in screen after the password
A code asked for after the password at sign-in: from the authenticator app, a backup code, or an emailed one-time code. Each operator switches it on for their own account and an owner may require it of everyone; a sign-in through the identity provider is held to the provider's own steps instead.
_Avoid_: 2FA, MFA (say the mechanism), verification (that word is for the address)

**Single sign-on**:
Arabic: الدخول الموحد
Signing in to the admin area through the install's one identity provider instead of a password, which an owner sets up and may require of everyone but owners. It signs in an account by its verified address, or makes one from an open invitation or an allowed domain.
_Avoid_: SSO (in copy), OAuth (say the protocol only in operator docs), social login

**Subscriber**:
Arabic: مشترك
A visitor who opted in, with double opt-in confirmation, to receive subscriber notifications from a status page.
_Avoid_: follower, contact, user

**Subscription**:
Arabic: اشتراك
The record tying one subscriber to one status page through one channel, email or webhook. Lifecycle: pending, confirmed, unsubscribed; a person confirms it from the page its one-time link opens.
_Avoid_: follow, membership, feed subscription (a feed has no record)

**Trusted browser**:
Arabic: متصفح موثوق
A browser an operator chose to trust when entering the second step's code, which skips that account's second step for a while.
_Avoid_: trusted device, remembered device, remember me

**Visitor**:
Arabic: زائر
Anyone viewing a status page without signing in.
_Avoid_: customer, end user, guest

### Monitoring

**Acknowledge**:
Arabic: إقرار
The operator marking a monitor's open outage as known, once and with no undo; an acknowledged outage records when, not who. It stops that outage's reminders and nothing else: checks go on, the outage stays open, recovered is sent, and the next outage reminds again. Never shown on a status page or sent in a notification.
_Avoid_: mute, snooze, silence, resolve (an outage ends only with a recovered check)

**Assertion**:
Arabic: معيار (الجمع: معايير)
One rule in an HTTP monitor's success rules, such as "status code in 2xx" or "body contains X".
_Avoid_: condition, expectation, validation

**Capture**:
Arabic: الاستجابة المحفوظة
The response headers and the first part of the body kept with a check, when the monitor's capture mode says so (ADR-0004). Request headers are never part of it, and it never holds a credential the check sent, even when the response repeats one.
_Avoid_: log, snapshot, response dump, body

**Capture mode**:
Arabic: حفظ الاستجابة
A monitor's setting for when a capture is kept: off, on failure (down checks only), or always.
_Avoid_: logging level, debug mode

**Certificate record**:
Arabic: بيانات الشهادة
What Raaqeb knows about an HTTPS monitor's current certificate. One per monitor, replaced when the certificate changes; not a history.
_Avoid_: TLS info, cert log, certificate history

**Check**:
Arabic: فحص
One scheduled run of a monitor, including its retries, producing one result of up, degraded or down, with a response time and a reason. Retries never produce checks of their own. A monitor checked from several locations has one check per run of the install's own schedule, whose result is what its locations agree on; each location's own latest result is its location state.
_Avoid_: ping, run, probe (that is a process), attempt (that is one try inside a check), heartbeat (that word is taken)

**Check type**:
Arabic: نوع الفحص
The way a monitor watches its target: HTTP, TCP, DNS, Postgres, MySQL, Redis, MongoDB, Docker, heartbeat, and later others.
_Avoid_: monitor type, probe type

**Confirmation count**:
Arabic: عدد المواقع المؤكِّدة
How many of a monitor's locations must see it down for its check to be down and its outage to open, one by default (ADR-0012). Degraded follows the same count.
_Avoid_: quorum, threshold (that is the degraded one), retries (those are inside one check)

**Container monitor**:
Arabic: مراقبة حاوية
A monitor of check type Docker, whose check asks the Docker daemon about one container by name: up while it runs and is not unhealthy, down otherwise.
_Avoid_: Docker check, container check (that is one run), service monitor

**Database monitor**:
Arabic: مراقبة قاعدة بيانات
A monitor of check type Postgres, MySQL, Redis or MongoDB, whose check signs in with its connection URL and runs a trivial query or the operator's own read-only one. The connection URL holds the password, so it is a credential.
_Avoid_: DB check, datastore monitor, connection string (say connection URL)

**Day**:
Arabic: يوم
Every day boundary in stored history (sealing, rollups, day bar cells) is a UTC day. The install time zone and the calendar change how a timestamp is rendered, never which day a check belongs to.
_Avoid_: local day, calendar day

**Degraded**:
Arabic: متعثّر
A check that succeeded but exceeded the monitor's response-time threshold. A monitor without a threshold is never degraded.
_Avoid_: slow, warning, partial

**Domain registration**:
Arabic: تسجيل النطاق
What Raaqeb knows about the registration of the domain an HTTP, TCP or DNS monitor's host is in, chiefly when it expires, read from the domain's registry. One per monitor; an unknown date never warns.
_Avoid_: WHOIS record, domain expiry info, DNS record (that is what a DNS check queries)

**Downtime**:
Arabic: زمن التعطّل
The time a monitor spent in outages inside a window, counted only where that time is observed time. Always read from outage records, never from check counts.
_Avoid_: outage time, down time, unavailability

**Error budget**:
Arabic: ميزانية التعطّل
The downtime an uptime target allows over a report's observed time: one minus the target, times the observed time. A report shows how much of it the downtime used and how much is left; a negative left is the target missed.
_Avoid_: allowance, SLO, quota

**Failure detail**:
Arabic: تفاصيل الفشل
The record kept beside a down check: the failed assertion with the observed value, the reason's parameters and the raw error text, capped. Deleted with its day's sealed row.
_Avoid_: error log, detail record, failure record

**Grace period**:
Arabic: فترة السماح
The extra time after a heartbeat monitor's expected period before a missing heartbeat counts as late.
_Avoid_: tolerance, slack, buffer

**Group**:
Arabic: مجموعة
A folder that a monitor belongs to, one level deep, at most one per monitor.
_Avoid_: folder, category, project

**Head table**:
Arabic: جدول يومي
The table holding the open UTC day's raw checks as plain rows, one per check, keyed by monitor and time. The nightly sealing job moves each closed day out of it.
_Avoid_: checks table, live table, hot table

**Heartbeat**:
Arabic: نبضة
One incoming call from the user's job to a heartbeat monitor's unique URL, saying the job ran or that it failed, with an optional short message and exit code.
_Avoid_: ping, beat, push

**Heartbeat monitor**:
Arabic: مراقبة النبض
A monitor that expects the target to send heartbeats on a schedule: down when one is late or says the job failed, up again when one says the job ran.
_Avoid_: push monitor, cron monitor, dead man's switch

**Location**:
Arabic: موقع الفحص (الجمع: مواقع الفحص); موقع in a list of them
A place a monitor is checked from: the main location or a probe. A monitor has one or more, the main location alone by default, and each keeps its latest result as its location state, which turns unknown, never down, when it is too old (ADR-0012).
_Avoid_: region, site (that is a web site), node, agent

**Main location**:
Arabic: الرئيسي (الموقع الرئيسي)
The install itself as a location: its own scheduler's checks.
_Avoid_: local, home, primary, this server

**Monitor**:
Arabic: مراقبة (الجمع: مراقبات)
One thing Raaqeb watches, with a check type, a schedule and success rules. Belongs to at most one group and any number of tags.
_Avoid_: probe (that is a process checking from elsewhere), check (for the configured thing), service, target

**Observed time**:
Arabic: وقت مرصود
The part of a window in which Raaqeb had checks to judge a monitor by. Maintenance windows, paused time and gaps in the checks are no data, not observed time (ADR-0005).
_Avoid_: total time, uptime window, SLA period

**Outage**:
Arabic: انقطاع
A recorded span of one monitor being down: opened by its first confirmed down check, closed by its first recovered check, with the reason. Kept on its own, so it outlives the checks that produced it. Downtime is the sum of outage durations.
_Avoid_: incident (the human record), downtime event, failure

**Paused**:
Arabic: مُعلَّق
A monitor state in which no checks run. Paused monitors are ignored when deriving component status, and paused time shows as no data, not downtime.
_Avoid_: disabled, stopped, muted

**Probe**:
Arabic: مسبار (الجمع: مسابير)
A Raaqeb process run elsewhere with `raaqeb probe`, with no database and no admin area, that pulls the monitors assigned to it from the install, checks them and pushes their results back; every connection starts at the probe (ADR-0012). One not heard from for a while is silent.
_Avoid_: agent, worker, node, remote monitor, check (that is one run)

**Probe token**:
Arabic: رمز المسبار
The bearer token a probe sends with every request, shown once and stored only as a hash, so a lost token is replaced, never read back.
_Avoid_: API key, password, secret (the install key's word)

**Reason**:
Arabic: علة for why a check failed (the notification line); سبب for why any check ended as it did (the checks table, passes included)
Why a check ended as it did: one code from a fixed list (timeout, connection refused, assertion failed, heartbeat late, and so on) with the values it saw, rendered in the reader's locale, never free text (ADR-0004).
_Avoid_: error message (that is the raw text kept beside a failed check), status message, cause

**Report**:
Arabic: تقرير (تقرير التوفّر)
A read-only account of one subject's uptime against an uptime target over a range of whole UTC days, the subject a monitor, a group, a component or a status page. Built from what the status page's bars read, so its figures match theirs; made when asked, stored nowhere. Its mean time to recovery is the mean duration of the outages that recovered inside the range; its mean time to acknowledge, the mean wait for an acknowledge among the outages that have one; its degraded time, an estimate, each day's observed time scaled by its share of degraded checks; its time with no data, the range less observed time and maintenance.
_Avoid_: SLA report, availability report, statistics

**Retention**:
Arabic: مدة الاحتفاظ
How long a monitor's check history exists: an install-wide setting with a per-monitor override, inside which older history is kept as hourly and then daily rollups (ADR-0005).
_Avoid_: history length, TTL, data period

**Rollup**:
Arabic: ملخّص (الجمع: ملخّصات); the daily pass that writes them is عملية التلخيص اليومية
One row summarising a monitor's checks over an hour or a day, which long-range charts read. Uptime takes only the observed time from them; downtime always comes from outage records (ADR-0005).
_Avoid_: aggregate, stat, bucket, downsample

**Sealed day**:
Arabic: يوم مغلف
A closed UTC day of one monitor's raw checks stored as one packed, compressed row instead of one row per check, every field still readable (ADR-0005). "Chunk" is the internal name of the packed blob in code, never in copy.
_Avoid_: archive, compressed history

**Size budget**:
Arabic: ميزانية التخزين
The maximum database size setting, unlimited by default. When set, Raaqeb deletes the oldest check history to stay under it, never outages, incidents, certificate records, domain registrations or settings (ADR-0005).
_Avoid_: quota, disk limit, cap

**Success rules**:
Arabic: معايير النجاح
An HTTP monitor's ordered list of assertions that must all pass for a check to be up. "Response time under N" is an assertion and fails the check; the degraded threshold is a separate field and never fails one.
_Avoid_: validation, health rule, expectations

**Tag**:
Arabic: وسم
A free label attached to any number of monitors, for filtering.
_Avoid_: label

**Uptime**:
Arabic: نسبة التوفّر
A monitor's share of a window it was not down: one minus its downtime over its observed time (ADR-0005). A window with no observed time has no uptime. Distinct from a component's uptime, which is the union rule of its linked monitors and incidents.
_Avoid_: availability, SLA, health, readiness

**Uptime target**:
Arabic: هدف التوفّر
The uptime a report judges against, 99.9 unless the operator types another. It belongs to the report that is asked for and to no monitor, and is met when uptime, not rounded, reaches it.
_Avoid_: SLA (a promise made to someone else; the target is only the figure it usually names), objective, threshold

### Notifications

**Monitor event**:
Arabic: حدث المراقبة
One of six things a monitor can report: down, recovered, degraded started, degraded ended, certificate expiring, domain expiring. A late heartbeat is "down" for a heartbeat monitor. Toggled per monitor.
_Avoid_: alert, trigger, state change

**Notification channel**:
Arabic: قناة إشعار
A configured destination for messages, such as a Slack webhook or an SMTP mailbox. Channels belong to the install; each monitor selects which ones it uses.
_Avoid_: notifier, integration, alert target

**Notification hold**:
Arabic: إيقاف الإشعارات
A state an import may leave the install in, so a copy of another install does not speak for it: no operator notification and no subscriber notification is sent, and none is kept to send later. A channel's test message, sign-in mail and a subscription's confirmation still go, since a person on this install asked for each. It lasts until an owner or admin ends it.
_Avoid_: mute, quiet mode, silence, pause (that is a monitor's)

**Notification preview**:
Arabic: معاينة الإشعارات
On a notification channel's page, each operator notification the channel can receive, written as it would be sent but with sample values. It sends nothing and writes nothing.
_Avoid_: dry run, mock notification, template

**Operator notification**:
Arabic: إشعار المشغّل; one about a problem (down, still down, degraded started, certificate expiring, domain expiring) is a تنبيه
A message sent by a monitor event to the team's notification channels. Distinct from subscriber notifications.
_Avoid_: alert (ambiguous), alarm

**Reminder**:
Arabic: تذكير
An optional repeat of a "still down" operator notification every N minutes while a monitor stays down, until its outage is acknowledged. Off by default.
_Avoid_: re-alert, escalation

**Subscriber notification**:
Arabic: إشعار المشترك
A message sent to a status page's subscribers on one of seven events affecting a component the page shows: incident published or updated, maintenance scheduled, rescheduled, started, completed or cancelled. Distinct from operator notifications.
_Avoid_: alert, broadcast

### Status page

**Access page**:
Arabic: صفحة الوصول
What a visitor without access meets at a view address of a private page: the page's own frame and branding with its way in, a password form, a way to sign in, or word that the visitor's network is not one the page opens from.
_Avoid_: login page, lock screen, gate

**Change counter**:
Arabic: عدّاد التغيّرات
One install-wide number that every write able to change public content advances, and the scheduler too on a timer, so figures that grow with the clock alone reach a memoised page. The memo is valid while it matches.
_Avoid_: version, revision, ETag (that is the header derived from a stored body)

**Component**:
Arabic: مكوّن
Something the install reports on, with a status level. Belongs to the install, not to a page; any page may show it. Its status comes from its linked monitors, its incidents and its maintenance, or is set by hand while it has no monitor. Its day bar and uptime count the union of its linked monitors' outages and the time incidents held it at partial or major outage.
_Avoid_: service, system, monitor (a component is not a monitor), effective status (say the component's status)

**Component group**:
Arabic: مجموعة المكوّنات
A one-level folder of components on a status page, showing an aggregate status.
_Avoid_: category, section

**Day bar**:
Arabic: شريط الأيام
A row of cells, one per UTC day, coloured in steps by that day's uptime, on a status page and in the admin area. Each cell opens a card for its day.
_Avoid_: 90-day bar (its length varies), uptime bar, heatmap, sparkline (that is the response-time line)

**Derived status**:
Arabic: الحالة المستنتجة
The status level computed for a component from its linked, unpaused monitors: all down means major outage, some down means partial outage, any degraded means degraded performance, otherwise operational. If every linked monitor is paused, the last derived status stands: the one the monitors paused last derive.
_Avoid_: automatic status, monitor status

**Feed**:
Arabic: موجز
A status page's Atom feed of its incidents and maintenance windows, one in each locale. It has no subscription record and no confirmation.
_Avoid_: RSS subscription, feed subscriber

**Impact level**:
Arabic: مستوى التأثير. Levels: بلا تأثير، طفيف، كبير، حرج.
How bad an incident is for visitors: none, minor, major, critical. Separate from the status level of components, which the page banner follows.
_Avoid_: severity, priority

**Incident**:
Arabic: حادثة. Stages: قيد التحرّي، تم تحديد السبب، قيد المتابعة، تم الحل.
A human-written record of a problem, belonging to the install, with an impact level, affected components, and a lifecycle of investigating, identified, monitoring, resolved. Shown on every status page that shows an affected component. Resolved is final: a problem that returns is a new incident. Never created automatically.
_Avoid_: outage (the derived span), alert, event

**Incident update**:
Arabic: تحديث الحادثة
One timestamped message on an incident, with its author, the lifecycle stage it moves to and the status it sets on each affected component. An update may add an affected component and never removes one. The resolving one ends the incident's hold on its components.
_Avoid_: comment, post, note

**Link** (monitor to component):
Arabic: ارتباط
The many-to-many relationship that lets monitors drive a component's status.
_Avoid_: binding, mapping, attachment

**Maintenance series**:
Arabic: وقت صيانة متكرر. Its recurrence: التكرار (أسبوعيًا، شهريًا).
A maintenance window that repeats by a recurrence, weekly on chosen days or monthly on a day of the month or an nth weekday, at a start time on the clock of its time zone, for a duration. It schedules its occurrences ahead of time; editing or ending it changes the ones still scheduled.
_Avoid_: recurring incident, cron, schedule (that is a monitor's)

**Maintenance window**:
Arabic: وقت الصيانة. Stages: مُجدوَل، جارٍ، مكتمل.
A scheduled period, with a start and end, during which affected components show under maintenance and the monitors linked to them send no operator notification and have no observed time. Lifecycle: scheduled, in progress, completed. A window is one period, or one occurrence of a maintenance series.
_Avoid_: scheduled incident, downtime, planned outage

**Memo**:
Arabic: مستذكَر
The in-process copy of every response that is the same for everyone it answers: a status page's HTML, JSON documents, feeds and badges, its not-found and access pages, and the sign-in, recovery and onboarding pages. An entry is served again until the change counter or the UTC date moves; then it is stale, and may still answer while its one refresh runs, so a visitor can briefly see the previous state (ADR-0006).
_Avoid_: cache, CDN, snapshot

**Occurrence**:
Arabic: موعد
One maintenance window a maintenance series scheduled. It is a window like any other and may be changed or cancelled on its own, leaving the series as it is. Subscribers are told once for the whole series when it is scheduled, rescheduled or cancelled, and for each occurrence when it starts and completes.
_Avoid_: instance, event, repetition

**Page access**:
Arabic: الوصول
Who may see a published status page: everyone (public, the default), visitors who enter its page password, anyone signed in to this install, or visitors from its allowed addresses.
_Avoid_: visibility, privacy, permissions, protection

**Page pass**:
Arabic: تصريح الصفحة
What a visitor's browser holds for one private page after its page password was entered, letting it back in for a while. It opens no other page and ends with a new page password.
_Avoid_: session (that is a sign-in), token, access cookie

**Private page**:
Arabic: صفحة خاصة
A published status page whose page access is not public. Everything it serves answers only a request its access lets in; anyone else meets its access page. Its subscribers keep their subscriptions and subscriber notifications, whose links lead through its access.
_Avoid_: hidden page, protected page, unpublished page (that one no visitor can see)

**Published**:
Arabic: منشورة
Whether a status page is shown at all, a switch the operator sets. Visitors cannot find an unpublished page, though the signed-in operator still sees it. Not a private page: no visitor can be let in.
_Avoid_: draft, live, visible, private (that is a published page with page access)

**Render pace**:
Arabic: وتيرة العرض
How often the app may start a full render for strangers: one at a time, spaced apart, each kind of page with a short queue of its own. Past it a stranger is asked to try again.
_Avoid_: rate limit (that is Better Auth's count of sign-ins per address), throttle

**Status level**:
Arabic: مستوى الحالة. Levels: يعمل، قيد الصيانة، متعثّر، انقطاع جزئي، انقطاع كلي.
One of five fixed states of a component or page: operational, degraded performance, partial outage, major outage, under maintenance. A page's status level is the worst among the components it shows. Labels can be renamed per page for display; states cannot be added.
_Avoid_: health, severity, impact (impact belongs to incidents)

**Status page**:
Arabic: صفحة حالة
A page, once published, one of many per install, that shows a chosen set of components and the incidents affecting them. Public unless its page access makes it a private page. Has a slug, an optional custom domain, and its own customization. One page can be the default for the bare host.
_Avoid_: dashboard, public page, site

**Stranger**:
Arabic: غريب
Whoever sends a request without a live operator session: a visitor, a scanner, someone at the sign-in page. Every render a stranger causes takes its turn at the render pace; a memo answer costs none.
_Avoid_: anonymous user, guest, attacker (most strangers are visitors)

**View**:
Arabic: واجهة عرض
One thing a visitor can open on a status page: the overview, the incident history of one month (its resolved incidents and completed maintenance windows), one incident, one maintenance window. Each view has its own JSON document and renders from nothing else.
_Avoid_: page (that is the status page), screen, route

### Product shape

**Appearance settings**:
Arabic: إعدادات المظهر
The install's choices of theme, size, density and radius for the admin area (ADR-0009). Visitors get the theme only, from their own browser.
_Avoid_: look, skin, style, branding (that is per status page)

**Boot setting**:
Arabic: إعداد التشغيل
A value Raaqeb needs before it can open the database, such as the port, the database URL or the install key: read from the environment or from `config.json` in the data directory, never edited in the admin area.
_Avoid_: config, environment variable (that is where it comes from, not what it is)

**Client certificate**:
Arabic: شهادة العميل
The certificate, with its private key, that an HTTP monitor presents to a server that requires mutual TLS. The certificate is public text in the monitor's config; the key is a sealed credential.
_Avoid_: mTLS certificate, TLS credentials, PKI

**Client credentials**:
Arabic: بيانات اعتماد العميل
How an HTTP monitor authenticates with the OAuth 2.0 client credentials grant: it asks a token endpoint for a token with its client ID and sealed client secret, and sends the token as a bearer. The token is a credential too, never stored, logged or captured.
_Avoid_: OAuth login, API key, token auth (that is the bearer token field)

**Data directory**:
Arabic: مجلد البيانات
The one folder Raaqeb owns on disk: the SQLite file, pre-upgrade snapshots and local state. Backing it up backs up an on-disk install.
_Avoid_: data folder, volume (that is how Docker provides it), config directory

**Database backend**:
Arabic: نوع قاعدة البيانات
Where Raaqeb keeps its data: SQLite in a file on this server (the default profile) or a Postgres server reached by URL, chosen once at onboarding. Every feature works on both. A backend is a choice inside storage, not an optional capability.
_Avoid_: database engine, driver (that is the code, not the choice), storage (that word covers retention), optional capability

**Default profile**:
Arabic: افتراضيات
Everything enabled on a fresh install. It must run one monitor on 1 vCPU and 240 MB RAM (ADR-0001).
_Avoid_: core mode, lite mode

**Export**:
Arabic: تصدير
One file, `raaqeb-export.jsonl.zst`, holding the install's configuration and, in the full mode, its check history, for another install to import. The way to move between hosts or backends; its credentials are in clear, so it is handled like a backup.
_Avoid_: backup (a backup is a copy of the database itself), dump

**Import**:
Arabic: استيراد
Loading an export into an install that has no monitors, status pages, components, incidents or maintenance windows yet. It starts a notification hold unless the operator turns that off.
_Avoid_: restore, merge, sync

**Install key**:
Arabic: مفتاح راقب
The secret that encrypts credentials at rest: monitor and channel credentials, SMTP passwords, the Postgres URL. From the environment, or generated on first boot; never exported. What Raaqeb only compares (one-time codes, the metrics token, probe tokens) is hashed, not encrypted.
_Avoid_: encryption key, master key, secret (Better Auth's secret is a different value)

**Metrics endpoint**:
Arabic: المقاييس
`GET /metrics`, the install's monitors in the Prometheus text format for a Prometheus or Grafana Agent to read. Off until the operator turns it on; it answers only a request that carries the metrics token.
_Avoid_: exporter, stats, API (the management API is another), status endpoint

**Metrics token**:
Arabic: رمز المقاييس
The bearer token a request to the metrics endpoint carries, shown once and stored only as a hash, so a lost token is replaced, never read back.
_Avoid_: API key (that is an operator's, for the management API), password, secret (the install key's word)

**Optional capability**:
Arabic: ميزة اختيارية
A feature that is off by default, enabled deliberately by the operator, and may raise the resource requirements beyond the floor. Lives behind the capability registry (ADR-0001). Check types and channels are compiled in; nothing is loaded from outside the repository.
_Avoid_: plugin, add-on, premium, backend (that is the database choice)

**Outbound proxy**:
Arabic: الوكيل الصادر
The HTTP proxy that HTTP checks, the notification channels' senders and the release check connect through, for an install that reaches the internet only through one: the environment's for the install, or an HTTP monitor's own. Never SOCKS; other checks open their own connections.
_Avoid_: trusted proxies (the reverse proxy in front of Raaqeb, the other direction), gateway, tunnel

**Public address**:
Arabic: عنوان عام
The URL at which visitors and the operator reach the install, as a setting. Reset links, subscriber emails and auth origin checks use it.
_Avoid_: base URL, site URL, host, domain (custom domains belong to status pages)

**Setting**:
Arabic: إعداد
A value the operator edits in the admin area and Raaqeb stores in the database: everything that is not a boot setting. One the environment overrides, such as the trusted proxies, shows as managed by environment.
_Avoid_: preference, option, config

**Setup check**:
Arabic: تهيئة راقب
One rule, shown on a read-only page under settings, that compares what the server sees with what the install is configured for and says, in plain words, what is wrong and how to fix it. It judges only facts the server already holds, and says nothing where it cannot know.
_Avoid_: health check (that is `GET /health`), diagnostics, doctor, onboarding (that runs before the account exists)

### Language

**Calendar**:
Arabic: التقويم
How a date reads and is typed: Gregorian, Hijri (the Umm al-Qura calendar), or Hijri with the Gregorian date beside it. A setting, Gregorian by default, that each operator may override for their own screens; a status page and every notification show the install's. Storage, day boundaries, exports, feeds, the API and logs stay Gregorian.
_Avoid_: date format, Islamic calendar, lunar calendar

**Channel language**:
Arabic: لغة القناة
The locale a notification channel's messages are written in, defaulting to the install language.
_Avoid_: notification language, alert language

**Content**:
Arabic: محتوى
The prose an operator writes for visitors, one text per locale: the names, titles and descriptions of components, pages, incidents and maintenance windows, and a page's status names and footer links. Where one locale's text is missing another's shows, never a blank. Monitor and channel names are not content: only the operator reads them.
_Avoid_: copy (that is the catalog's), translation (that is the act of producing one), localized text

**Install language**:
Arabic: لغة التثبيت
The locale chosen on the onboarding page, Arabic by default and changeable in settings. Every operator, status page and channel starts from it.
_Avoid_: default language, system language

**Locale**:
Arabic: لغة
One of the two interface languages Raaqeb ships, Arabic or English. A locale chooses the words and the reading direction only; digits, calendar, clock and time zone are settings and do not change with it.
_Avoid_: language code, culture, region, translation (that is the act of producing one)

**Message catalog**:
Arabic: فهرس الرسائل
The file holding every interface message for one locale. Translating Raaqeb means editing or adding one; the community contributes by changing it.
_Avoid_: translation file, strings file, dictionary, resource bundle

**Operator language**:
Arabic: لغة المشغّل
An operator's own locale for the admin area, kept on their account, defaulting to the install language.
_Avoid_: user language, profile language

**Page language**:
Arabic: لغة الصفحة
A status page's own locale, shown at its plain address; the other locale has its own address. Its content needs text in it.
_Avoid_: page locale, site language

**Subscription language**:
Arabic: لغة الاشتراك
The locale of the status page address a subscriber signed up from: the page language at its plain address, the other locale under its prefix. Their confirmation, incident emails and webhook text keep it.
_Avoid_: subscriber locale
