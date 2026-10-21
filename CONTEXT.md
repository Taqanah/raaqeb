# Raaqeb

Raaqeb (راقب, "keep watch over") is a self-hosted, single-tenant monitoring and status page tool. This glossary fixes the words the project uses. `docs/adr/` holds the decisions that are hard to reverse.

## Language

### Install and people

**Install**:
Arabic: تثبيت
One running Raaqeb serving one organization. Owns all monitors, channels, components, incidents and status pages.
_Avoid_: instance, tenant, workspace, account

**Operator**:
Arabic: مشغّل
A signed-in human who manages the install, with what their role allows.
_Avoid_: user (ambiguous with visitors), member, staff

**Operator account**:
Arabic: حساب المشغّل
An email-and-password identity that can sign in to the admin area, with a name, one role and the operator's own preferences. Onboarding creates the first, as an owner; each later one comes from an invitation or, under single sign-on, from the identity provider. Several may exist; the email is unique among them.
_Avoid_: admin user, root, superuser, user, member

**Role**:
Arabic: دور (الجمع: أدوار). Roles: مالك، مدير، محرّر، مستجيب، مشاهد.
What an operator account may do, one of five, each allowing everything the next one does: a viewer reads the admin area; a responder also runs "check now", acknowledges outages, writes incidents and schedules maintenance; an editor also changes monitors, status pages and components and deletes incidents; an admin also changes notification channels and settings, reads the audit log and manages every account but an owner's; an owner also gives and takes the owner role, exports and imports, and sets how operators sign in. Every operator, whatever the role, changes their own account. An install always has at least one owner who is not deactivated.
_Avoid_: permission level, access level, group, admin (alone, for the area)

**Invitation**:
Arabic: دعوة
An owner's or admin's offer of an operator account to one email address with one role: a single-use link, emailed through the auth email channel when one exists and always shown for copying, that works for seven days. Accepting it sets the name and password and signs in; under single sign-on, signing in through the identity provider with that address accepts it too. Sending it again makes a new link and the old one stops working; revoking it stops it at once. It stays open only while its sender may still give its role. An address that already has an account cannot be invited.
_Avoid_: invite code, sign-up link, magic link

**Audit entry**:
Arabic: مُدخل في سجل التدقيق; the page is سجل التدقيق
One record of who did what to what, from which address and when: a change an operator made in the admin area, a sign-in, or a refused sign-in with the email typed. It keeps what was asked without secrets, never what a password or key was. Entries are only added, read by owners and admins, travel in the export, and are deleted once older than the install's retention.
_Avoid_: activity feed, history (that is a monitor's checks), event (that is a monitor's change of state), log (alone: that is the server's output)

**Deactivated**:
Arabic: معطّل
An operator account that cannot sign in: deactivating it ends its sessions at once and keeps the account, its role and its name, so reactivating it restores it with a new sign-in. Removing an account is the other way to end its access, for good.
_Avoid_: banned, suspended, disabled (in copy), paused (that is a monitor's state)

**Onboarding**:
Arabic: مرحلة الإعداد
The state of an install before any operator account exists. Raaqeb serves only the onboarding pages then: language, database backend, operator account. Ends when the first account, its owner, is created; the pages are gone afterwards.
_Avoid_: first run, setup mode, installation (that is putting the binary on the server)

**Getting-started checklist**:
Arabic: خطوات البدء
The card above the monitors list that names the four things a new install needs: a monitor, a component linked to a monitor and a published status page, in the order they depend on each other, then a notification channel. Each step ticks once its thing exists. The card closes for good the first time all four exist, so undoing a step later does not bring it back, or when the operator dismisses it; whether it is closed is the one thing it stores.
_Avoid_: setup wizard, tour, onboarding (that ends when the account exists), setup check (that compares what the server sees with the configuration)

**Second step**:
Arabic: استيثاق ثنائي for the setting (الاستيثاق الثنائي مفعّل); الخطوة الثانية for the sign-in screen after the password
A code required after the password at sign-in: from the authenticator app when one is set up, a backup code, or an emailed one-time code where an email channel exists. Switched on by each operator for their own account, with emailed codes once a test message reached their address or by setting up the authenticator app. Off by default; turning it off removes the authenticator app and its backup codes. An owner may require it of every operator: one without it then reaches only their own account until they switch it on. A sign-in through the identity provider is held to the provider's own steps instead.
_Avoid_: 2FA, MFA (say the mechanism), verification (that word is for the address)

**Single sign-on**:
Arabic: الدخول الموحد
Signing in to the admin area through the install's one identity provider instead of a password, which an owner sets up and may require. It makes an account for an address with an open invitation, with the invitation's role, or, if the owner allows, for an address at a listed domain, with the role its claims map to; never an owner's. An address that has an account signs in as it once the provider says the address is verified. Once required, only owners sign in with a password, so the install has a way in when the provider is down.
_Avoid_: SSO (in copy), OAuth (say the protocol only in operator docs), social login

**Identity provider**:
Arabic: مزوّد الهوية
The OpenID Connect service an organisation signs its people in with (Keycloak, Authentik, Okta, Entra ID, Google Workspace), which single sign-on sends the browser to and trusts for who someone is.
_Avoid_: IdP (in copy), auth server, SSO provider

**Authenticator app**:
Arabic: تطبيق الاستيثاق
An app on an operator's phone that shows a new six-digit code every 30 seconds from a secret it shares with the install. Set up from a QR code or the secret as text, and in force only once its first code is entered.
_Avoid_: TOTP in UI copy, authenticator (alone), token generator, 2FA app

**Backup code**:
Arabic: رمز احتياطي
One of ten codes shown once when the authenticator app is set up, each good for one sign-in in place of the app's code. A new set replaces every code of the old one.
_Avoid_: recovery code, one-time code (that is the emailed one), spare code

**One-time code**:
Arabic: رمز مؤقت
A six-digit code emailed to an operator, valid for five minutes and three attempts, used by the second step. The authenticator app's codes and backup codes are not one-time codes. Password recovery uses a reset link, not a code.
_Avoid_: OTP in UI copy, token (in auth copy; the design component that isolates machine tokens keeps its name), PIN

**Trusted browser**:
Arabic: متصفح موثوق
A browser an operator chose to trust when entering the second step's code. It skips that account's second step for 30 days. A password reset forgets every trusted browser.
_Avoid_: trusted device, remembered device, remember me

**Reset link**:
Arabic: رابط إعادة التعيين
A one-time link, valid for a limited time, that opens the set-new-password page. Emailed by "forgot password", or printed by the reset command when there is no email.
_Avoid_: magic link (that is a sign-in mechanism Raaqeb does not offer), reset token in UI copy

**Visitor**:
Arabic: زائر
Anyone viewing a status page without signing in.
_Avoid_: customer, end user, guest

**Subscriber**:
Arabic: مشترك
A visitor who opted in, with double opt-in confirmation, to receive subscriber notifications from a status page.
_Avoid_: follower, contact, user

**Subscription**:
Arabic: اشتراك
The record tying one subscriber to one status page through one channel, email or webhook. Lifecycle: pending, confirmed, unsubscribed. Both channels confirm the same way: a person opens the one-time link, which works for 48 hours, and presses the button on its page; opening the link alone confirms nothing. A webhook receives the link in its first POST.
_Avoid_: follow, membership, feed subscription (a feed has no record)

### Monitoring

**Monitor**:
Arabic: مراقبة (الجمع: مراقبات)
One thing Raaqeb watches, with a check type, a schedule and success rules. Belongs to at most one group and any number of tags.
_Avoid_: probe (that is a process checking from elsewhere), check (for the configured thing), service, target

**Check type**:
Arabic: نوع الفحص
The way a monitor watches its target: HTTP, TCP, DNS, Postgres, MySQL, Redis, Docker, heartbeat, and later others.
_Avoid_: monitor type, probe type

**Check**:
Arabic: فحص
One scheduled run of a monitor, including its retries, producing one result of up, degraded or down, a response time, a reason and the number of attempts it took. Retries never produce checks of their own. A monitor checked from several locations keeps one check per run of the install's own schedule, whose result is what its locations agree on by the confirmation count and whose figures are one agreeing location's; each location's own latest result is its location state, not a check of the history.
_Avoid_: ping, run, probe (that is a process), attempt (that is one try inside a check), heartbeat (that word is taken)

**Reason**:
Arabic: علة for why a check failed (the notification line); سبب for why any check ended as it did (the checks table, passes included)
Why a check ended as it did: one code from a fixed list (timeout, DNS failed, connection refused, certificate expired, unexpected status, assertion failed, slow, heartbeat late, heartbeat failed, client certificate refused, token request failed, and so on) with the values it saw. Rendered in the reader's locale; never free text.
_Avoid_: error message (that is the raw text kept beside a failed check), status message, cause

**Capture**:
Arabic: الاستجابة المحفوظة
The response headers and the first part of the body kept with a check, only when the monitor's capture mode says so: off, on failure only, or always. Credentials and request headers are never part of it, not even when the response repeats one: each credential the check sent is masked. The values of the standard request headers Accept, Accept-Encoding, Accept-Language, Content-Type, Cache-Control and User-Agent are not credentials and stay as they are.
_Avoid_: log, snapshot, response dump, body

**Certificate record**:
Arabic: بيانات الشهادة
What Raaqeb knows about an HTTPS monitor's current certificate: subject, issuer, validity dates, names, fingerprint, last seen. One per monitor, replaced when the certificate changes.
_Avoid_: TLS info, cert log, certificate history

**Domain registration**:
Arabic: تسجيل النطاق
What Raaqeb knows about the registration of the domain an HTTP, TCP or DNS monitor's host is in: the registered domain, when the registration expires or that the date is unknown, last read. Read from the domain's registry once a day. One per monitor, on by default; an unknown date never warns.
_Avoid_: WHOIS record, domain expiry info, DNS record (that is what a DNS check queries)

**Success rules**:
Arabic: معايير النجاح
An HTTP monitor's ordered list of assertions that must all pass for a check to be up. "Response time under N" is an assertion and fails the check; the degraded threshold is a separate field and never fails one.
_Avoid_: validation, health rule, expectations

**Assertion**:
Arabic: معيار (الجمع: معايير)
One rule in an HTTP monitor's success rules, such as "status code in 2xx" or "body contains X".
_Avoid_: condition, expectation, validation

**Capture mode**:
Arabic: حفظ الاستجابة
A monitor's setting for when a capture is kept: off, on failure (down checks only; a degraded check keeps nothing), or always.
_Avoid_: logging level, debug mode

**Database monitor**:
Arabic: مراقبة قاعدة بيانات
A monitor of check type Postgres, MySQL or Redis. Each check opens a connection with its connection URL, signs in, runs `SELECT 1`, `PING` or the operator's own query, and closes it; when the monitor names an expected value, the first value the query answers must be that text. The connection URL holds the password, so it is a credential: sealed with the install key, kept on edit when left out, never shown again.
_Avoid_: DB check, datastore monitor, connection string (say connection URL)

**Container monitor**:
Arabic: مراقبة حاوية
A monitor of check type Docker. Each check asks the daemon's Engine API, over a Unix socket or an http or https URL, about one container by its name, which survives a recreate where an id does not. It is up while the container runs and its health check, if it has one, has not called it unhealthy; a container that is missing, not running, restarting, paused, dead or unhealthy is down, each with its own reason. The endpoint carries no credentials and is stored in the clear.
_Avoid_: Docker check, container check (that is one run), service monitor

**Heartbeat monitor**:
Arabic: مراقبة النبض
A monitor that expects the target to send heartbeats on a schedule. Once per expected period plus grace period it produces one check: up if a heartbeat arrived since the last one, otherwise down with the reason "heartbeat late" and no response time. While it is down, a heartbeat produces an up check at once rather than at the period's end. A heartbeat that says the job failed does the opposite: the monitor is down at once, with the reason "heartbeat failed", until the next heartbeat that says the job ran.
_Avoid_: push monitor, cron monitor, dead man's switch

**Grace period**:
Arabic: فترة السماح
The extra time after a heartbeat monitor's expected period before a missing heartbeat counts as late.
_Avoid_: tolerance, slack, buffer

**Heartbeat**:
Arabic: نبضة
One incoming call from the user's job to a heartbeat monitor's unique URL. It says the job ran, or, at the URL's fail address or with a failing status or a nonzero exit code, that it failed, with an optional short message and exit code.
_Avoid_: ping, beat, push

**Location**:
Arabic: موقع الفحص (الجمع: مواقع الفحص); موقع in a list of them
A place a monitor is checked from: the main location or a probe. A monitor has one or more, the main location alone by default. Each location runs the monitor's checks on its interval and keeps its latest result as its location state, which is unknown once it is older than twice the interval plus the longest a check can take. A probe's state is never down for being silent; it is unknown. A result whose check started before the monitor last changed (an edit, a pause, a resume) counts for nothing. A monitor checked from probes alone that none has a recent result for has no state: it is neither up nor down, and its components keep their last status as for a paused monitor.
_Avoid_: region, site (that is a web site), node, agent

**Main location**:
Arabic: الرئيسي (الموقع الرئيسي)
The install itself as a location: its own scheduler's checks. Every monitor before locations existed is checked from it alone.
_Avoid_: local, home, primary, this server

**Probe**:
Arabic: مسبار (الجمع: مسابير)
A Raaqeb process run elsewhere with `raaqeb probe`, with no database and no admin area, that pulls the monitors assigned to it from the install, checks them and pushes their results back; every connection starts at the probe. It can check HTTP, TCP, DNS and database monitors; a database monitor's credentials, and an HTTP monitor's, reach it only when the monitor shares them. Made in the admin area, where its last contact, its version and its round trip show. One not heard from for two minutes is silent: the channels of the monitors it checks are told once, and again when it reports.
_Avoid_: agent, worker, node, remote monitor, check (that is one run)

**Probe token**:
Arabic: رمز المسبار
The bearer token a probe sends with every request. Shown once when the probe is made or given a new token; only its SHA-256 is stored, so a lost token is replaced, never read back. A new token stops the old one at once. Its hash travels in an export, so a moved install's probes keep working.
_Avoid_: API key, password, secret (the install key's word)

**Confirmation count**:
Arabic: عدد المواقع المؤكِّدة
How many of a monitor's locations must see it down for its check to be down and its outage to open, one by default. While fewer of its locations have a known state, every one that has must agree, so a silent probe never hides an outage. Degraded follows the same count.
_Avoid_: quorum, threshold (that is the degraded one), retries (those are inside one check)

**Degraded**:
Arabic: متعثّر
A check that succeeded but exceeded the monitor's response-time threshold. A monitor without a threshold is never degraded.
_Avoid_: slow, warning, partial

**Outage**:
Arabic: انقطاع
A recorded span of one monitor being down: opened by its first confirmed down check, closed by its first recovered check, with the reason. Kept on its own, so it outlives the checks that produced it. Downtime is the sum of outage durations.
_Avoid_: incident (the human record), downtime event, failure

**Acknowledge**:
Arabic: إقرار
The operator marking a monitor's open outage as known, once and with no undo; an acknowledged outage records when, not who. It stops that outage's reminders and nothing else: checks go on, the outage stays open, recovered is sent, and the next outage reminds again. Never shown on a status page or sent in a notification.
_Avoid_: mute, snooze, silence, resolve (an outage ends only with a recovered check)

**Paused**:
Arabic: مُعلَّق
A monitor state in which no checks run. Paused monitors are ignored when deriving component status, and paused time shows as no data, not downtime.
_Avoid_: disabled, stopped, muted

**Group**:
Arabic: مجموعة
A folder that a monitor belongs to, one level deep, at most one per monitor.
_Avoid_: folder, category, project

**Tag**:
Arabic: وسم
A free label attached to any number of monitors, for filtering.
_Avoid_: label

**Retention**:
Arabic: مدة الاحتفاظ
How long a monitor's check history exists, as a setting with an install-wide default of 90 days and a per-monitor override. Inside it the history is raw checks for the smaller of 30 days and the retention, hourly rollups for the smaller of 90 days and the retention, daily rollups to the limit.
_Avoid_: history length, TTL, data period

**Rollup**:
Arabic: ملخّص (الجمع: ملخّصات); the daily pass that writes them is عملية التلخيص اليومية
One row summarising a monitor's checks over an hour or a day: check count, average, minimum and maximum response time, failed and degraded counts, and observed time. Long-range charts read rollups. Uptime takes only the observed time from them; downtime always comes from outage records.
_Avoid_: aggregate, stat, bucket, downsample

**Head table**:
Arabic: جدول يومي
The table holding the open UTC day's raw checks as plain rows, one per check, keyed by monitor and time. The nightly sealing job moves each closed day out of it.
_Avoid_: checks table, live table, hot table

**Sealed day**:
Arabic: يوم مغلف
A closed UTC day of one monitor's raw checks stored as one packed, compressed row instead of one row per check. Every field of the check row stays readable. Written by the nightly sealing job, which also writes that day's rollups. The open day stays in the head table. "Chunk" is the internal name of the packed blob in code, never in copy.
_Avoid_: archive, compressed history

**Failure detail**:
Arabic: تفاصيل الفشل
The record kept beside a down check: the failed assertion with the observed value, the reason's parameters and the raw error text, capped. Deleted with its day's sealed row.
_Avoid_: error log, detail record, failure record

**Day**:
Arabic: يوم
Every day boundary in stored history (sealing, rollups, day bar cells) is a UTC day. The install time zone and the calendar change how a timestamp is rendered, never which day a check belongs to.
_Avoid_: local day, calendar day

**Observed time**:
Arabic: وقت مرصود
The part of a window in which Raaqeb had checks to judge a monitor by. Maintenance windows, paused time and gaps longer than twice the interval (for a heartbeat monitor, twice its expected period plus grace period) are no data and are not observed time. Paused time is known only as such a gap; no pause history is kept.
_Avoid_: total time, uptime window, SLA period

**Downtime**:
Arabic: زمن التعطّل
The time a monitor spent in outages inside a window, counted only where that time is observed time. Always read from outage records, never from check counts.
_Avoid_: outage time, down time, unavailability

**Uptime**:
Arabic: نسبة التوفّر
A monitor's share of a window it was not down: one minus its downtime over its observed time. Shown rounded down, so any outage keeps it under 100%. A window with no observed time has no uptime. Distinct from a component's uptime, which is the union rule of its linked monitors and incidents.
_Avoid_: availability, SLA, health, readiness

**Report**:
Arabic: تقرير (تقرير التوفّر)
A read-only account of one subject's uptime over a range of whole UTC days, built from the daily rollups, the outage records, the incidents and the maintenance windows the status page's bars already read, so its figures match theirs. The subject is a monitor, a group, a component or a status page; for a group or a page the report lists each member (the group's monitors, the page's components) and adds them up, downtime and observed time summed, so a member with more observed time weighs more; a page's total adds its distinct monitors, each once however many of its components link it, and its components with no monitor, so a monitor two components share is not counted twice, though each component's own line counts it. The range is a UTC month, a UTC quarter or any run of days up to 366, never past today (a last day after today is cut to today); one that includes today is marked as not over. It states the uptime against the uptime target, the error budget, the downtime, the outage count, the incident count, the mean time to recovery, the mean time to acknowledge, the degraded time, the time under maintenance and the time with no data, and lists the worst outages. An outage or an incident counts in a report when it ran inside the range, an outage with its time there less maintenance and never more of a day than the monitor was observed that day, as the bars cap it. Mean time to recovery is the mean duration of the outages that recovered inside the range, mean time to acknowledge the mean wait for an acknowledge among the outages that have one; a report leaves out a mean it has nothing to read. Degraded time is an estimate: each day's observed time scaled by its share of degraded checks (a component takes the most of its monitors' on each day). The time with no data is the range less observed time and maintenance. A report is made when asked, stores nothing and has no schedule; it downloads as CSV and prints from the browser.
_Avoid_: SLA report, availability report, statistics

**Uptime target**:
Arabic: هدف التوفّر
The uptime a report judges against, a percentage above 0 and below 100 with up to three decimals, 99.9 unless the operator types another. It belongs to the report that is asked for, in its address, and to no monitor: the same monitor can be read against two targets. Met when uptime, not rounded, reaches it.
_Avoid_: SLA (a promise made to someone else; the target is only the figure it usually names), objective, threshold

**Error budget**:
Arabic: ميزانية التعطّل
The downtime an uptime target allows over a report's observed time: one minus the target, times the observed time. A report shows how much of it the downtime used and how much is left; a negative left is the target missed.
_Avoid_: allowance, SLO, quota

**Size budget**:
Arabic: ميزانية التخزين
The maximum database size setting, default unlimited. When set, Raaqeb deletes the oldest history before a write that would cross it: raw days, then hourly, then daily rollups; never outages, incidents, certificate records, domain registrations or settings. With or without a number, a local SQLite file keeps a 64 MB reserve of free disk; Postgres has no such signal.
_Avoid_: quota, disk limit, cap

### Notifications

**Notification channel**:
Arabic: قناة إشعار
A configured destination for messages, such as a Slack webhook or an SMTP mailbox. Channels belong to the install; each monitor selects which ones it uses.
_Avoid_: notifier, integration, alert target

**Monitor event**:
Arabic: حدث المراقبة
One of six things a monitor can report: down, recovered, degraded started, degraded ended, certificate expiring, domain expiring. A late heartbeat is "down" for a heartbeat monitor. Toggled per monitor.
_Avoid_: alert, trigger, state change

**Operator notification**:
Arabic: إشعار المشغّل; one about a problem (down, still down, degraded started, certificate expiring, domain expiring) is a تنبيه
A message sent by a monitor event to the team's notification channels. Distinct from subscriber notifications.
_Avoid_: alert (ambiguous), alarm

**Reminder**:
Arabic: تذكير
An optional repeat of a "still down" operator notification every N minutes while a monitor stays down, until its outage is acknowledged. Off by default.
_Avoid_: re-alert, escalation

**Notification preview**:
Arabic: معاينة الإشعارات
On a notification channel's page, each operator notification the channel can receive (down, the reminder, recovered, degraded started and ended, certificate expiring, domain expiring) as that channel's type carries it, in the channel language, written by the same code that sends it with sample values: a made-up monitor and target, the install's clock and calendar, a sample downtime and time left. Marked as a sample; it sends nothing and writes nothing.
_Avoid_: dry run, mock notification, template

**Subscriber notification**:
Arabic: إشعار المشترك
A message sent to a status page's subscribers on one of seven events affecting a component the page shows: incident published, incident updated (every update, including the resolving one), maintenance scheduled, maintenance rescheduled (an edit moved its start or end), maintenance started, maintenance completed, maintenance cancelled. All seven are always on. Distinct from operator notifications.
_Avoid_: alert, broadcast

### Status page

**Status page**:
Arabic: صفحة حالة
A page, once published, one of many per install, that shows a chosen set of components and the incidents affecting them. Public unless its page access makes it a private page. Has a slug, an optional custom domain, and its own customization. One page can be the default for the bare host.
_Avoid_: dashboard, public page, site

**Published**:
Arabic: منشورة
Whether a status page is shown at all, a switch the operator sets. A new page starts unpublished. An unpublished page is not found by visitors at any of its addresses, takes no subscription and sends its subscribers nothing; the signed-in operator sees it at its own address, marked as not published. Not a private page: no visitor can be let in.
_Avoid_: draft, live, visible, private (that is a published page with page access)

**Page access**:
Arabic: الوصول
Who may see a published status page: everyone (public, the default), visitors who enter its page password, anyone signed in to this install, or visitors from its allowed addresses (IP addresses or CIDR ranges, matched against the client address behind the trusted proxies). In password mode allowed addresses may be set too, and either lets a visitor in. Anyone signed in to this install sees a page of any mode. A new page password ends every page pass the old one earned; leaving password mode forgets the password.
_Avoid_: visibility, privacy, permissions, protection

**Private page**:
Arabic: صفحة خاصة
A published status page whose page access is not public. Its views, documents, feeds, badges, summary and subscription form answer only a request its access lets in; anyone else meets its access page at a view's address and nothing at the rest. It is kept in the memo like any page, answered only after the access check, never cached by anyone but the visitor's own browser and never indexed. It frames no not-found. Its subscribers keep their subscriptions and their subscriber notifications, whose links lead through its access.
_Avoid_: hidden page, protected page, unpublished page (that one no visitor can see)

**Access page**:
Arabic: صفحة الوصول
What a visitor without access meets at any view address of a private page: the page's own frame and branding with its way in. In password mode a form for the page password, which says when a try was wrong or one too many; in signed-in mode the way to sign in; in allowed-addresses mode only that the visitor's network is not one the page opens from. The same document for every visitor of one page, locale and host.
_Avoid_: login page, lock screen, gate

**Page pass**:
Arabic: تصريح الصفحة
What a visitor's browser holds for one private page after its page password was entered: a cookie sealed with the install key that names the page, the password it was earned with and when it ends, 30 days on. It opens no other page and ends with a new page password.
_Avoid_: session (that is a sign-in), token, access cookie

**View**:
Arabic: واجهة عرض
One thing a visitor can open on a status page: the overview, the incident history of one month (its resolved incidents and completed maintenance windows), one incident, one maintenance window. Each view has its own JSON document and renders from nothing else.
_Avoid_: page (that is the status page), screen, route

**Feed**:
Arabic: موجز
A status page's Atom feed of its incidents and maintenance windows, one in each locale. Anyone the page lets in can read it, everyone for a public page; there is no subscription record and no confirmation.
_Avoid_: RSS subscription, feed subscriber

**Day bar**:
Arabic: شريط الأيام
A row of cells, one per UTC day, coloured in steps by that day's uptime. On a status page it shows a component's last 30, 60 or 90 days, as the page's bar length says; a phone shows at most the last 30 and a tablet at most the last 60. Hover, focus or a tap opens the day's card: its status, uptime, downtime, mean response time, the incidents and maintenance windows that ran on it and a link to the history of its UTC month. Today's cell is live. The admin's monitors table draws a monitor's last 14 days the same way beside its state, its outages over its observed time, and the admin's component list a component's last 30 days beside its uptime over 90. The monitor detail draws a monitor's last 90 days over its chart, the card listing the day's outages and zooming the chart to the day.
_Avoid_: 90-day bar (its length varies), uptime bar, heatmap, sparkline (that is the response-time line)

**Memo**:
Arabic: مستذكَر
The in-process copy of every status page response (HTML, JSON document, feed, badge), a private page's answered only to a request its page access lets in, of the not-found every address of one frame shows and the access page of each private page, and of the sign-in, recovery and onboarding pages that are the same for everyone, kept and served again until the change counter or the UTC date moves. Once either moves an entry is stale: it is refreshed once, and a request that the refresh does not answer within half a second gets the stale entry, so a visitor may see the previous state for as long as one refresh takes. It has no lifetime and no size rule beyond its caps: pages times locales times views plus the summary, feeds and badges for the public responses, as many again for the not-founds, and one per page and locale for the sign-in pages.
_Avoid_: cache, CDN, snapshot

**Stranger**:
Arabic: غريب
Whoever sends a request without a live operator session: a visitor, a scanner, someone at the sign-in page. Every render a stranger causes takes its turn at the render pace; a memo answer costs none.
_Avoid_: anonymous user, guest, attacker (most strangers are visitors)

**Render pace**:
Arabic: وتيرة العرض
How often the app may start a full render for strangers: one at a time, half a second apart once the turns an idle spell saved up are spent, the kinds of page taking turns (a stale status page answer's refresh, a status page address the memo holds nothing for, the pages that are the same for everyone, a subscription's page, an open reset link, onboarding, and every other page), each with a short queue of its own. Past it a stranger is asked to try again in a second.
_Avoid_: rate limit (that is Better Auth's count of sign-ins per address), throttle

**Change counter**:
Arabic: عدّاد التغيّرات
One install-wide number that every write able to change public content advances, including a failing check while down, a purge and a size-budget delete, and that the scheduler also advances every five minutes, so figures that grow with the clock alone (today's cell, a window's uptime) reach a memoised page. The memo is valid while it matches.
_Avoid_: version, revision, ETag (that is the header derived from a stored body)

**Component**:
Arabic: مكوّن
Something the install reports on, with a status level. Belongs to the install, not to a page; any page may show it. Its status is derived from its linked monitors, or set by hand while it has none; an incident update's status replaces the hand-set one and wins over the derived one where it is worse; an active maintenance window overrides all. Its day bar and uptime count the union of its linked monitors' outages and the time incidents held it at partial or major outage.
_Avoid_: service, system, monitor (a component is not a monitor), effective status (say the component's status)

**Component group**:
Arabic: مجموعة المكوّنات
A one-level folder of components on a status page, showing an aggregate status.
_Avoid_: category, section

**Link** (monitor to component):
Arabic: ارتباط
The many-to-many relationship that lets monitors drive a component's status.
_Avoid_: binding, mapping, attachment

**Derived status**:
Arabic: الحالة المستنتجة
The status level computed for a component from its linked, unpaused monitors: all down means major outage, some down means partial outage, any degraded means degraded performance, otherwise operational. If every linked monitor is paused, the last derived status stands: the one the monitors paused last derive.
_Avoid_: automatic status, monitor status

**Status level**:
Arabic: مستوى الحالة. Levels: يعمل، قيد الصيانة، متعثّر، انقطاع جزئي، انقطاع كلي.
One of five fixed states of a component or page: operational, degraded performance, partial outage, major outage, under maintenance. A page's status level is the worst among the components it shows, in the order operational, under maintenance, degraded performance, partial outage, major outage, and the page banner shows it. Labels can be renamed per page and per locale for display only, and a locale without a renamed label shows the catalog's word; states cannot be added and machine values never change.
_Avoid_: health, severity, impact (impact belongs to incidents)

**Incident**:
Arabic: حادثة. Stages: قيد التحرّي، تم تحديد السبب، قيد المتابعة، تم الحل.
A human-written record of a problem, belonging to the install, with an impact level, affected components, and a lifecycle of investigating, identified, monitoring, resolved. Its affected components are the ones its updates name. Shown on every status page that shows at least one affected component; deleting the last of its affected components deletes it, since it would be on no page. Resolved is final: a problem that returns is a new incident. Never created automatically in v1.
_Avoid_: outage (the derived span), alert, event

**Incident update**:
Arabic: تحديث الحادثة
One timestamped message on an incident, with its author, the lifecycle stage it moves to, and the status it sets on each affected component. An update may add an affected component and never removes one; the update that first names a component also keeps the status the page showed for it just before, which a subscriber's webhook reports as where the component came from. Resolving ends the incident's hold on every affected component: one set by hand returns to the status it had before the incident, its own hand-set status, which the incident never wrote, unless the operator keeps the status the incident set; a linked component follows its monitors again, so a monitor still down keeps it red.
_Avoid_: comment, post, note

**Impact level**:
Arabic: مستوى التأثير. Levels: بلا تأثير، طفيف، كبير، حرج.
How bad an incident is for visitors: none, minor, major, critical. Opens the incident's line of details on the status page and leads the subscriber email; the banner follows the page's status level. Separate from the status level of components.
_Avoid_: severity, priority

**Maintenance window**:
Arabic: وقت الصيانة. Stages: مُجدوَل، جارٍ، مكتمل.
A scheduled period, with a start and end, during which affected components show under maintenance. Lifecycle: scheduled, in progress, completed; the scheduler moves it at its start and its end. Deleting the last of its affected components deletes it at any stage, since it would be on no page. While in progress it covers every monitor linked to one of its components, whatever their other components show; for a covered monitor operator notifications are suppressed and the time is not observed. An unlinked monitor is never in maintenance. If a covered monitor is still down when the window ends, the down notification is sent then. A window is one period, or one occurrence of a maintenance series.
_Avoid_: scheduled incident, downtime, planned outage

**Maintenance series**:
Arabic: وقت صيانة متكرر. Its recurrence: التكرار (أسبوعيًا، شهريًا).
A maintenance window that repeats, by a recurrence: weekly on one or more days, or monthly on a day of the month or on an nth weekday (the second Tuesday, the last Friday); at a start time on the clock of its time zone, for a duration. Each occurrence starts at that wall-clock time whatever the daylight-saving offset that day; a start time the clock skips that day starts when the clock reaches it after the change, one it repeats starts the first time. Day 29, 30 or 31 falls on the last day of a shorter month. The series schedules each occurrence a week before it starts, or at once when it is created or edited. Editing the series replaces its scheduled occurrences with the new recurrence's, one changed on its own included; one cancelled on its own stays cancelled, and one in progress and the completed ones stay as they are. Ending the series cancels its scheduled occurrences; one in progress runs to its end. Deleting the last of its components ends it.
_Avoid_: recurring incident, cron, schedule (that is a monitor's)

**Occurrence**:
Arabic: موعد
One maintenance window a maintenance series scheduled. It is an ordinary window in every way: it is announced to subscribers when scheduled, shows on the status pages, covers its monitors while in progress, and may be changed or cancelled on its own, which leaves the series and its other occurrences as they are.
_Avoid_: instance, event, repetition

### Product shape

**Default profile**:
Arabic: افتراضيات
Everything enabled on a fresh install. It must run one monitor on 1 vCPU and 240 MB RAM.
_Avoid_: core mode, lite mode

**Optional capability**:
Arabic: ميزة اختيارية
A feature that is off by default, enabled deliberately by the operator, and may raise the resource requirements beyond the floor. Lives behind the capability registry (ADR-0001). Check types and channels are compiled in; nothing is loaded from outside the repository.
_Avoid_: plugin, add-on, premium, backend (that is the database choice)

**Appearance settings**:
Arabic: إعدادات المظهر
The install's choices of theme, size, density and radius for the admin area, stored as token scales and applied in the first paint. Visitors get the theme only, from their own browser.
_Avoid_: look, skin, style, branding (that is per status page)

**Database backend**:
Arabic: نوع قاعدة البيانات
Where Raaqeb keeps its data: SQLite in a file on this server (the default profile) or a Postgres server reached by URL. Chosen once on the onboarding page. Every feature works on both. A backend is a choice inside storage, not an optional capability.
_Avoid_: database engine, driver (that is the code, not the choice), storage (that word covers retention), optional capability

**Data directory**:
Arabic: مجلد البيانات
The one folder Raaqeb owns on disk: the SQLite file, pre-upgrade snapshots and local state. Backing it up backs up an on-disk install.
_Avoid_: data folder, volume (that is how Docker provides it), config directory

**Boot setting**:
Arabic: إعداد التشغيل
A value Raaqeb needs before it can open the database: port, bind address, data directory, database URL, install key. Read from the environment, or from `config.json` in the data directory for the two values onboarding writes there (the database URL chosen on the page and the generated install key); never edited in the admin area. A UI field covered by a boot setting shows as managed by environment.
_Avoid_: config, environment variable (that is where it comes from, not what it is)

**Install key**:
Arabic: مفتاح راقب
The secret that encrypts credentials at rest: HTTP monitor credentials, a database monitor's connection URL, channel credentials, SMTP passwords, the Postgres URL. Comes from the environment, or is generated on first boot into `config.json` in the data directory and reused on every later boot. Never exported. One-time codes, the metrics token and probe tokens are hashed, not encrypted; a reset link is neither, since it works once and expires within the hour.
_Avoid_: encryption key, master key, secret (Better Auth's secret is a different value)

**Public address**:
Arabic: عنوان عام
The URL at which visitors and the operator reach the install, as a setting: pre-filled on the onboarding account screen with the address the browser is at, stored only after a confirmation when the browser is elsewhere, and editable in settings or from the server with `raaqeb set-address`. Reset links, subscriber emails and auth origin checks use it.
_Avoid_: base URL, site URL, host, domain (custom domains belong to status pages)

**Setting**:
Arabic: إعداد
A value the operator edits in the admin area and Raaqeb stores in the database. Everything that is not a boot setting. The trusted proxies are a setting that `RAAQEB_TRUSTED_PROXIES` overrides: where the variable is set it wins, and the field shows as managed by environment.
_Avoid_: preference, option, config

**Outbound proxy**:
Arabic: الوكيل الصادر
The HTTP proxy that the HTTP checks, the notification channels' senders and the daily release check connect through, for an install that reaches the internet only through one. Install-wide it is the runtime's `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` from the environment, read at each request. An HTTP monitor may set its own, an http or https address whose user name and password are sealed with its credentials; it overrides the environment for that monitor and ignores `NO_PROXY`. Never SOCKS. A TCP, DNS, database or Docker check, the certificate read and an SMTP send open their own connections and never go through it.
_Avoid_: trusted proxies (the reverse proxy in front of Raaqeb, the other direction), gateway, tunnel

**Client certificate**:
Arabic: شهادة العميل
The certificate an HTTP monitor presents to a server that requires the client to prove itself over TLS (mutual TLS), with the private key that belongs to it. The certificate, and the CA certificates the monitor trusts in place of the well-known ones, are public PEM text kept in the monitor's config; the key and its passphrase, when the key is encrypted, are sealed credentials, written and never read back. A certificate outside its validity dates fails the check before any request is sent, with its own reason; a server that closes the handshake of a request that carried one reads as the certificate refused. It needs an https address and works through the outbound proxy.
_Avoid_: mTLS certificate, TLS credentials, PKI

**Client credentials**:
Arabic: بيانات اعتماد العميل
How an HTTP monitor authenticates with the OAuth 2.0 client credentials grant: its token URL, client ID and sealed client secret, an optional scope and audience, and how the client authenticates to the token endpoint (HTTP basic or its ID and secret in the request body). Each attempt sends the token as a bearer. The token is asked of the endpoint inside the attempt's own time, kept in memory per monitor until a tenth of its lifetime (at most a minute) before it ends, and asked for again after; it is never stored, logged or captured, and the client secret never leaves the sealed credentials. A token request that fails is the reason "token request failed" with the endpoint's status. The monitor's own proxy carries the token request too.
_Avoid_: OAuth login, API key, token auth (that is the bearer token field)

**Setup check**:
Arabic: تهيئة راقب
One rule, shown on a read-only page under settings, that compares what the server sees with what the install is configured for and says, in plain words, what is wrong and how to fix it: forwarded headers from a peer that is not a trusted proxy, a public address that is not the origin the browser is at, no email channel, a data directory open to other users while it holds secrets, a data directory holding secrets on a container's overlay root filesystem, on a volume Docker made without a name, or in memory on tmpfs. Each judges facts the server already holds; none makes an outbound call or stores anything. A check that cannot know says nothing: a root filesystem that is no overlay may be a host's disk or a VM's ephemeral one, so it gets no verdict.
_Avoid_: health check (that is `GET /health`), diagnostics, doctor, onboarding (that runs before the account exists)

**Metrics endpoint**:
Arabic: المقاييس
`GET /metrics`, the install's monitors in the Prometheus text format for a Prometheus or Grafana Agent to read: per monitor whether it is up, degraded or paused, its latest response time and check time, its uptime over the last seven UTC days and its certificate's expiry, labelled by monitor (name and id), group and check type. Off until the operator turns it on in settings; it answers only a request that carries the metrics token. It reads what the install already holds and renders no page.
_Avoid_: exporter, stats, API (the install has no management API), status endpoint

**Metrics token**:
Arabic: رمز المقاييس
The bearer token a request to the metrics endpoint carries. Turning the endpoint on makes it and shows it once; only its SHA-256 is stored, so a lost token is replaced, never read back. Making a new one stops the old one at once; turning the endpoint off forgets it. It does not travel in an export.
_Avoid_: API key (a management API with keys may replace it later), password, secret (the install key's word)

**Export**:
Arabic: تصدير
One file, `raaqeb-export.jsonl.zst` (JSON Lines under zstd), whose first line is the install's configuration (monitors, groups, tags, channels, components, status pages, incidents, maintenance windows, subscriptions, the operator accounts without their passwords, sessions or second step, and the settings that travel) and whose following lines, in the full mode, are the check history one record per line, so another install can import it as a stream. The way to move between hosts or backends. Credentials are written in clear, so the file is handled like a backup. One export downloads at a time, and the export page shows the full file's size as an estimate.
_Avoid_: backup (a backup is a copy of the database itself), dump

**Import**:
Arabic: استيراد
Loading an export into an install that has no monitors, status pages, components, incidents or maintenance windows; any other install refuses it. Credentials are encrypted again with the importing install's key, and the file's settings replace the install's own, except the public address. Each operator account the install lacks, by id and by email, is created with its role, name and preferences and no password, so it signs in once a reset link sets one; an account the install has keeps its own.
_Avoid_: restore, merge, sync

### Language

**Locale**:
Arabic: لغة
One of the two interface languages Raaqeb ships, Arabic or English. A locale chooses the words and the reading direction only; digits, calendar, clock and time zone are settings and do not change with it.
_Avoid_: language code, culture, region, translation (that is the act of producing one)

**Calendar**:
Arabic: التقويم
How a date reads, and how the operator types one: Gregorian, Hijri (the Umm al-Qura calendar), or Hijri with the Gregorian date beside it. A setting, Gregorian by default, that each operator may override for their own screens; a status page and every notification show the install's. It changes display and entry alone: storage, day boundaries, retention, exports, feeds, the API and logs stay Gregorian.
_Avoid_: date format, Islamic calendar, lunar calendar

**Install language**:
Arabic: لغة التثبيت
The locale chosen on the onboarding page, Arabic by default and changeable in settings. Every operator, status page and channel starts from it.
_Avoid_: default language, system language

**Operator language**:
Arabic: لغة المشغّل
An operator's own locale for the admin area, kept on their account, defaulting to the install language.
_Avoid_: user language, profile language

**Page language**:
Arabic: لغة الصفحة
A status page's own locale, shown at its plain address; the other locale has its own address, and the visitor switcher moves between them. Its content needs text in it; a view in the other locale shows that locale's content and falls back to the page language's.
_Avoid_: page locale, site language

**Content**:
Arabic: محتوى
The prose an operator writes for visitors, one text per locale: component names and descriptions, a page's title, description, status names, footer link labels and component group names, incident titles and update texts, maintenance window titles and descriptions. A page's content needs the page language's text, and a component's, an incident's or a maintenance window's the install language's; the other locale's is optional. A status name is the exception: either locale may hold one alone. A view, a feed, a badge and a subscriber notification show their own locale's text, else the page language's, else the one locale that has some, never a blank; a status name without one shows the catalog's word. Monitor and channel names are not content: only the operator reads them.
_Avoid_: copy (that is the catalog's), translation (that is the act of producing one), localized text

**Channel language**:
Arabic: لغة القناة
The locale a notification channel's messages are written in, defaulting to the install language.
_Avoid_: notification language, alert language

**Subscription language**:
Arabic: لغة الاشتراك
The locale of the status page address a subscriber signed up from: the page language at its plain address, the other locale under its prefix. Their confirmation, incident emails and webhook text keep it.
_Avoid_: subscriber locale

**Message catalog**:
Arabic: فهرس الرسائل
The file holding every interface message for one locale. Translating Raaqeb means editing or adding one; the community contributes by changing it.
_Avoid_: translation file, strings file, dictionary, resource bundle
