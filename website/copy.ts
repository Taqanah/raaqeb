/**
 * The website's words in both locales. Arabic is the source; the one
 * type makes English complete or the build fails. Each locale leads with its
 * own case: Arabic first in Arabic, the size in English.
 */
import type { Locale } from "@/shared/i18n/locale.ts";
import { website } from "@/shared/ui/website.ts";

/** Where the website lives and the project's repository. */
export const site = website;
export const repository = "https://github.com/Taqanah/raaqeb";
export const installCommand = `curl -fsSL ${site}/install.sh | sudo sh`;
/** The docs' Docker command (website/content/docs/operate/install.en.mdx). */
export const dockerCommand =
  "docker run -d --name raaqeb --restart unless-stopped -p 3000:3000 -v raaqeb-data:/data ghcr.io/taqanah/raaqeb:0.1.0";
/** Each locale's docs. */
export const docsPath: Readonly<Record<Locale, string>> = {
  ar: "/docs",
  en: "/en/docs",
};

export type Section =
  | "pages"
  | "checks"
  | "alerts"
  | "admin"
  | "arabic"
  | "server"
  | "install";
export type CheckKind =
  | "http"
  | "tcp"
  | "dns"
  | "database"
  | "docker"
  | "heartbeat";
export type Level = "up" | "degraded" | "partial" | "down" | "maintenance";

/** A title and the line under it. */
export type Pair = readonly [string, string];

/** The sample status page's words, in its own language whatever the page's. */
export interface Demo {
  readonly banner: string;
  readonly bannerDegraded: string;
  readonly components: readonly [string, string, string, string];
  readonly dayCard: {
    readonly downtime: string;
    readonly incident: string;
    readonly minutes: string;
    readonly ms: string;
    readonly response: string;
    readonly uptime: string;
  };
  readonly days: string;
  readonly group: string;
  readonly grouped: readonly [string, string];
  readonly groupUp: string;
  readonly incidentImpact: string;
  readonly incidentTitle: string;
  readonly levels: Readonly<Record<Level, string>>;
  readonly maintenanceTitle: string;
  readonly maintenanceWhen: string;
  readonly subscribe: string;
  readonly today: string;
  /** The incident's updates as posted, oldest first: its stage, the update and its time. */
  readonly updates: readonly (readonly [string, string, string])[];
}

export interface Copy {
  readonly admin: {
    /** The screenshots' alternative text. */
    readonly alt: string;
    readonly lead: string;
    readonly title: string;
  };
  readonly alerts: {
    readonly down: Pair;
    /** The Slack channel the team's alerts go to. */
    readonly channel: string;
    readonly email: string;
    /** The label before the row of channels under the outage. */
    readonly through: string;
    readonly lead: string;
    readonly monitor: string;
    readonly scrub: string;
    readonly steps: readonly {
      readonly at: string;
      readonly kind: "down" | "sent" | "up";
      readonly second: number;
      readonly what: string;
    }[];
    readonly title: string;
    readonly up: Pair;
  };
  readonly arabic: {
    readonly calendar: {
      readonly gregorian: string;
      readonly hijri: string;
      readonly text: string;
    };
    readonly lead: string;
    readonly title: string;
  };
  readonly brand: string;
  readonly checks: {
    readonly detail: {
      readonly recent: string;
      readonly uptime: readonly [string, string, string, string];
    };
    readonly kinds: Readonly<
      Record<
        CheckKind,
        {
          readonly fields: readonly (
            | Pair
            | readonly [string, string, "text"]
          )[];
          readonly name: string;
          /** The sample monitor's state, in the product's word for it. */
          readonly state: string;
          readonly target: string;
        }
      >
    >;
    readonly lead: string;
    readonly title: string;
  };
  readonly command: {
    readonly copied: string;
    readonly copy: string;
    readonly runsOn: string;
  };
  /** A code block's copy button, before and after the copy. */
  readonly copyCode: { readonly copy: string; readonly copied: string };
  readonly demo: Demo;
  readonly description: string;
  readonly footer: {
    readonly api: string;
    readonly licence: string;
    readonly start: string;
  };
  readonly hero: {
    readonly accent: string;
    readonly docs: string;
    readonly install: string;
    readonly lead: string;
    readonly title: string;
  };
  readonly install: {
    readonly docker: string;
    readonly lead: string;
    readonly script: string;
    readonly steps: readonly [Pair, Pair, Pair];
    readonly title: string;
  };
  /** The locale these words are in. */
  readonly locale: Locale;
  readonly nav: {
    readonly alerts: string;
    readonly checks: string;
    readonly docs: string;
    readonly pages: string;
  };
  readonly order: readonly Section[];
  readonly other: string;
  readonly pages: {
    /** The row under the frame: its label, then the ways a visitor follows the page (email, webhook, feed, summary). */
    readonly also: string;
    readonly feeds: readonly [string, string, string, string];
    readonly lead: string;
    readonly title: string;
  };
  /** The preview image's alternative text. */
  readonly preview: string;
  /** The theme button's name; pressed means dark. */
  /** The docs header's search field. */
  readonly search: string;
  readonly server: {
    readonly chart: {
      /** The chart's caption; {date} is the run's day, in the locale's calendar. */
      readonly caption: string;
      readonly limit: string;
      readonly title: string;
    };
    readonly figure: string;
    readonly figures: readonly (readonly [string, string, string])[];
    readonly lead: string;
    readonly title: string;
  };
  readonly theme: string;
  readonly title: string;
}

const demoAr: Demo = {
  banner: "كل المكوّنات تعمل",
  bannerDegraded: "بعض المكوّنات متعثّرة",
  components: ["المتجر الإلكتروني", "بوابة الدفع", "تطبيق الجوال", "الإشعارات"],
  dayCard: {
    downtime: "مدة التعطّل",
    incident: "حادثة",
    minutes: "دقيقة",
    ms: "ملّي ثانية",
    response: "متوسط الاستجابة",
    uptime: "نسبة التوفّر",
  },
  days: "آخر 90 يومًا",
  group: "النسخ الاحتياطي",
  groupUp: "كل مكوّنات المجموعة تعمل",
  grouped: ["قاعدة البيانات", "الملفات"],
  incidentImpact: "تأثير طفيف",
  incidentTitle: "بطء في بوابة الدفع",
  levels: {
    degraded: "متعثّر",
    down: "انقطاع كلي",
    maintenance: "قيد الصيانة",
    partial: "انقطاع جزئي",
    up: "يعمل",
  },
  maintenanceTitle: "ترقية قاعدة البيانات",
  maintenanceWhen: "الجمعة 2 ص إلى 4 ص بتوقيت الرياض",
  subscribe: "اشترك",
  today: "اليوم",
  updates: [
    ["قيد التحرّي", "نتحرّى بطئًا في إتمام الدفع.", "14:02"],
    [
      "تم تحديد السبب",
      "استعلام بطيء على جدول الطلبات يستهلك اتصالات قاعدة البيانات.",
      "14:09",
    ],
    [
      "قيد المتابعة",
      "أُصلح الاستعلام وعاد الدفع إلى سرعته المعتادة. نتابع.",
      "14:21",
    ],
    ["تم الحل", "يعمل الدفع كالمعتاد منذ نصف ساعة.", "14:52"],
  ],
};

const demoEn: Demo = {
  banner: "All components operational",
  bannerDegraded: "Some components degraded",
  components: ["Storefront", "Payments", "Mobile app", "Notifications"],
  dayCard: {
    downtime: "Downtime",
    incident: "Incident",
    minutes: "min",
    ms: "ms",
    response: "Mean response",
    uptime: "Uptime",
  },
  days: "Last 90 days",
  group: "Backups",
  groupUp: "Every component in the group is operational",
  grouped: ["Database", "Files"],
  incidentImpact: "Minor impact",
  incidentTitle: "Slow payments",
  levels: {
    degraded: "Degraded",
    down: "Major outage",
    maintenance: "Under maintenance",
    partial: "Partial outage",
    up: "Operational",
  },
  maintenanceTitle: "Database upgrade",
  maintenanceWhen: "Friday 02:00 to 04:00 Riyadh time",
  subscribe: "Subscribe",
  today: "Today",
  updates: [
    ["Investigating", "We are looking into slow checkouts.", "14:02"],
    [
      "Identified",
      "A slow query on the orders table is exhausting database connections.",
      "14:09",
    ],
    [
      "Monitoring",
      "The query is fixed and payments are back to their usual speed. We are watching.",
      "14:21",
    ],
    ["Resolved", "Payments have run normally for half an hour.", "14:52"],
  ],
};

const ar: Copy = {
  admin: {
    alt: "لوحة تحكم راقب",
    lead: "بالعربية من اليمين إلى اليسار، بالنسق الفاتح أو الداكن. الصور من تثبيت حقيقي.",
    title: "كل مراقبة في *نظرة واحدة*.",
  },
  alerts: {
    down: ["بوابة الدفع: متعطّل", "رمز حالة غير متوقع (503)"],
    channel: "#العمليات",
    email: "البريد",
    through: "ينبّهك عبر",
    lead: "يعيد راقب المحاولة قبل أن يعلن التعطّل، ثم ينبّه كل قناة اخترتها بلغتها، وحين تتعافى المراقبة يخبرك كم دام الانقطاع.",
    monitor: "بوابة الدفع",
    scrub: "الوقت منذ أول فحص فاشل",
    steps: [
      {
        at: "14:02:10",
        kind: "down",
        second: 0,
        what: "فشل الفحص، يعيد المحاولة",
      },
      {
        at: "14:02:30",
        kind: "down",
        second: 20,
        what: "فشل مجددًا: بوابة الدفع متعطّلة",
      },
      {
        at: "14:02:31",
        kind: "sent",
        second: 21,
        what: "أُرسل التنبيه إلى 5 قنوات",
      },
      {
        at: "14:06:40",
        kind: "up",
        second: 270,
        what: "تعافت بعد 4 دقائق",
      },
    ],
    title: "*يتأكد* قبل أن ينبّهك.",
    up: ["بوابة الدفع: تعمل من جديد", "دام الانقطاع 4 دقائق."],
  },
  arabic: {
    calendar: {
      gregorian: "ميلادي",
      hijri: "هجري",
      text: "يكتب راقب كل تاريخ بالتقويم الذي تختاره: الهجري، أو الميلادي، أو الاثنين معًا.",
    },
    lead: "كُتبت واجهة راقب بالعربية من اليمين إلى اليسار، ثم تُرجمت إلى الإنجليزية. الصفحة الواحدة تُقرأ باللغتين، ويقرأ كل زائر لغته.",
    title: "*بالعربية* من أول سطر.",
  },
  brand: "راقب",
  checks: {
    detail: {
      recent: "أحدث الفحوص",
      uptime: ["24 ساعة", "7 أيام", "30 يومًا", "90 يومًا"],
    },
    kinds: {
      database: {
        fields: [
          ["رابط الاتصال", "postgres://ops:••••••@db.raaqeb.dev:5432/shop"],
          [
            "الاستعلام",
            "SELECT count(*) FROM orders WHERE paid_at > now() - interval '5 min'",
          ],
          ["القيمة المتوقعة", "أكبر من 0", "text"],
        ],
        name: "قواعد البيانات",
        state: "متعثّر",
        target: "db.raaqeb.dev/shop",
      },
      dns: {
        fields: [
          ["نوع السجل", "MX"],
          ["السجلات المتوقعة", "10 mail.raaqeb.dev"],
          ["الخادوم", "1.1.1.1"],
        ],
        name: "DNS",
        state: "يعمل",
        target: "raaqeb.dev",
      },
      docker: {
        fields: [
          ["نقطة الاتصال", "unix:///var/run/docker.sock"],
          ["اسم الحاوية", "shop-worker"],
        ],
        name: "Docker",
        state: "يعمل",
        target: "shop-worker",
      },
      heartbeat: {
        fields: [
          ["المدة", "كل يوم", "text"],
          ["فترة السماح", "ساعة", "text"],
          [
            "في cron",
            "0 3 * * * pg_dump shop | zstd > /backup/shop.zst && curl -fsS $HEARTBEAT",
          ],
        ],
        name: "النبض",
        state: "متعطّل",
        target: "status.raaqeb.dev/api/heartbeat/7f3a9c1e",
      },
      http: {
        fields: [
          ["الطريقة", "GET"],
          [
            "معايير النجاح",
            "رمز الحالة 2xx · الاستجابة خلال 800 ملّي ثانية · JSON $.status يساوي ok",
            "text",
          ],
          ["الشهادة", "تحذير قبل انتهائها بـ 14 يومًا", "text"],
        ],
        name: "HTTP",
        state: "يعمل",
        target: "https://pay.raaqeb.dev/health",
      },
      tcp: {
        fields: [
          ["المضيف", "db.raaqeb.dev"],
          ["المنفذ", "5432"],
        ],
        name: "TCP",
        state: "متعطّل",
        target: "db.raaqeb.dev:5432",
      },
    },
    lead: "ستة أنواع من الفحص، وتحذير قبل انتهاء شهادة أي موقع.",
    title: "من الموقع إلى *قواعد البيانات*.",
  },
  command: { copied: "نُسخ", copy: "نسخ", runsOn: "يعمل على" },
  demo: demoAr,
  description:
    "راقب نظام مراقبة تشغّله على خادومك: يفحص مواقعك وخواديمك وقواعد بياناتك، وينبّه فريقك عبر البريد وSlack وTelegram لحظة يتعطل شيء، وينشر صفحة حالة لعملائك.",
  footer: {
    api: "الواجهة البرمجية",
    licence:
      "راقب مجاني على خادومك، وشفرته المصدرية منشورة برخصة FSL-1.1-ALv2. يصير كل إصدار مرخّصًا برخصة Apache 2.0 بعد سنتين من صدوره.",
    start: "البدء",
  },
  hero: {
    accent: "راقب",
    docs: "التوثيقات",
    install: "ثبّت راقب",
    lead: "اعرف العطل قبل عملائك، وأصلحه قبل أن يسألوا.",
    title: "راقب مواقعك وخواديمك وقواعد بياناتك.",
  },
  install: {
    docker: "أو في Docker",
    lead: "ملف تنفيذي واحد، أو صورة Docker. ثلاث خطوات من خادوم فارغ إلى صفحة حالة منشورة.",
    script: "على الخادوم",
    steps: [
      [
        "ثبّت",
        "يختار المُثبِّت الملف التنفيذي المناسب لجهازك، ويتحقق من بصمته، ويشغّل راقب خدمةً تبدأ مع النظام.",
      ],
      [
        "أكمل الإعداد",
        "افتح العنوان الذي يطبعه المُثبِّت: اختر اللغة وقاعدة البيانات، وأنشئ حساب المشغّل.",
      ],
      [
        "أضف أول مراقبة",
        "رابط واحد وفاصل زمني وقناة تنبيه، ثم صفحة حالة تنشرها لزوارك.",
      ],
    ],
    title: "من أمر واحد إلى صفحة حالة، *في دقائق*.",
  },
  locale: "ar",
  nav: {
    alerts: "التنبيهات",
    checks: "الفحوص",
    docs: "التوثيقات",
    pages: "صفحات الحالة",
  },
  // The admin section waits for new screenshots; add "admin" back after "pages" to show it.
  order: ["checks", "alerts", "pages", "arabic", "server", "install"],
  other: "English",
  pages: {
    also: "يتابعها زوارك عبر",
    feeds: ["البريد", "Webhook", "موجز Atom", "ملخّص JSON"],
    lead: "صفحة لكل خدمة تقدّمها، بمكوّناتها ومجموعاتها وحوادثها وأوقات صيانتها. تتغير حالتها مع مراقباتها، ويشترك فيها زوارك ويقرؤونها بلغتهم.",
    title: "يعلم عملاؤك *قبل أن يسألوا*.",
  },
  server: {
    chart: {
      caption:
        "ذاكرة الحاوية: 1,500 مراقبة تُفحص كل ثانية، 77 ألف فحص، على نواة واحدة بحد 240 ميغابايت. من قياس الأداء الأخير في {date}، بقاعدة SQLite.",
      limit: "الحد 240 ميغابايت",
      title: "الذاكرة تحت الحمل",
    },
    figure:
      "ثلاثة أجزاء في عملية واحدة: المجدوِل وطابور الإشعارات وقاعدة البيانات، على نواة واحدة.",
    figures: [
      ["1", "نواة", "معالج افتراضي واحد"],
      ["800", "مراقبة", "كل 20 ثانية في 107 ميغابايت"],
      ["0.4", "ثانية", "من التشغيل إلى أول إجابة"],
      ["86", "ميغابايت", "ملف تنفيذي واحد لـ Linux وmacOS وWindows"],
      ["0", "خدمات خارجية", "SQLite أو Postgres، لا غير"],
    ],
    lead: "عملية واحدة على خادومك، بلا خدمات خارجية ولا رسوم. يُقاس كل إصدار في حاوية بنواة واحدة و240 ميغابايت قبل أن يصدر.",
    title: "نواة واحدة، و*240 ميغابايت*، ولا شيء غيرهما.",
  },
  search: "ابحث في التوثيقات",
  copyCode: { copied: "نُسخ النص", copy: "نسخ النص" },
  theme: "النسق الداكن",
  title: "راقب",
  preview: "واجهة راقب: صفحة حالة بمكوّناتها وأحدث الفحوص",
};

const en: Copy = {
  admin: {
    alt: "Raaqeb's admin",
    lead: "In Arabic and English, light or dark. The shots are from a real install.",
    title: "Everything you watch, *at a glance*.",
  },
  alerts: {
    down: ["Payments is down", "Unexpected status code (503)"],
    channel: "#ops",
    email: "Email",
    through: "Alerts through",
    lead: "One failed check is a blip, not an outage. Raaqeb tries again first, then reaches your team where they already are, and tells them how long it lasted once it is back.",
    monitor: "Payments",
    scrub: "Time since the first failed check",
    steps: [
      {
        at: "14:02:10",
        kind: "down",
        second: 0,
        what: "Check failed, trying again",
      },
      {
        at: "14:02:30",
        kind: "down",
        second: 20,
        what: "Failed again: Payments is down",
      },
      {
        at: "14:02:31",
        kind: "sent",
        second: 21,
        what: "Alert sent to 5 channels",
      },
      {
        at: "14:06:40",
        kind: "up",
        second: 270,
        what: "Up again after 4 minutes",
      },
    ],
    title: "No false alarms. *Only the real ones.*",
    up: ["Payments is up again", "The outage lasted 4 minutes."],
  },
  arabic: {
    calendar: {
      gregorian: "Gregorian",
      hijri: "Hijri",
      text: "Hijri, Gregorian, or both on every date. Your install, your calendar.",
    },
    lead: "Raaqeb was written right to left, in Arabic, and brought to English after. Not a translation bolted on: every visitor reads the page in their own language, dates in their own calendar.",
    title: "*Arabic first.* Not translated last.",
  },
  brand: "Raaqeb",
  checks: {
    detail: {
      recent: "Recent checks",
      uptime: ["24 hours", "7 days", "30 days", "90 days"],
    },
    kinds: {
      database: {
        fields: [
          ["Connection URL", "postgres://ops:••••••@db.raaqeb.dev:5432/shop"],
          [
            "Query",
            "SELECT count(*) FROM orders WHERE paid_at > now() - interval '5 min'",
          ],
          ["Expected value", "more than 0", "text"],
        ],
        name: "Databases",
        state: "Degraded",
        target: "db.raaqeb.dev/shop",
      },
      dns: {
        fields: [
          ["Record type", "MX"],
          ["Expected records", "10 mail.raaqeb.dev"],
          ["Server", "1.1.1.1"],
        ],
        name: "DNS",
        state: "Up",
        target: "raaqeb.dev",
      },
      docker: {
        fields: [
          ["Endpoint", "unix:///var/run/docker.sock"],
          ["Container name", "shop-worker"],
        ],
        name: "Docker",
        state: "Up",
        target: "shop-worker",
      },
      heartbeat: {
        fields: [
          ["Period", "every day", "text"],
          ["Grace period", "1 hour", "text"],
          [
            "In cron",
            "0 3 * * * pg_dump shop | zstd > /backup/shop.zst && curl -fsS $HEARTBEAT",
          ],
        ],
        name: "Heartbeats",
        state: "Down",
        target: "status.raaqeb.dev/api/heartbeat/7f3a9c1e",
      },
      http: {
        fields: [
          ["Method", "GET"],
          [
            "Success rules",
            "status 2xx · response under 800 ms · JSON $.status equals ok",
            "text",
          ],
          ["Certificate", "warn 14 days before it expires", "text"],
        ],
        name: "HTTP",
        state: "Up",
        target: "https://pay.raaqeb.dev/health",
      },
      tcp: {
        fields: [
          ["Host", "db.raaqeb.dev"],
          ["Port", "5432"],
        ],
        name: "TCP",
        state: "Down",
        target: "db.raaqeb.dev:5432",
      },
    },
    lead: "Six kinds of check, and a heads-up two weeks before any certificate runs out.",
    title: "From the homepage to *the database*.",
  },
  command: { copied: "Copied", copy: "Copy", runsOn: "Runs on" },
  demo: demoEn,
  description:
    "Raaqeb is self-hosted uptime monitoring with status pages. It checks your sites, servers and databases, alerts your team on email, Slack or Telegram the moment something breaks, and keeps your customers informed.",
  footer: {
    api: "API",
    licence:
      "Raaqeb is free to run on your own server, and its source is published under FSL-1.1-ALv2. Each release becomes Apache 2.0 two years after it ships.",
    start: "Get started",
  },
  hero: {
    accent: "Watch",
    docs: "Read the docs",
    install: "Install Raaqeb",
    lead: "Hear about an outage before your customers do, and fix it before they ask.",
    title: "Watch your sites, servers and databases.",
  },
  install: {
    docker: "Or in Docker",
    lead: "A single binary or a Docker image. Three steps from an empty server to a status page your customers can read.",
    script: "On the server",
    steps: [
      [
        "Install",
        "The installer picks the binary for your machine, checks its checksum, and starts Raaqeb as a service that boots with the system.",
      ],
      [
        "Finish onboarding",
        "Open the address it prints, pick a language and a database, and create your account. That is the whole setup.",
      ],
      [
        "Add the first monitor",
        "Paste a URL, choose where alerts go, and publish the page. You are watching.",
      ],
    ],
    title: "One command. *Live in minutes.*",
  },
  locale: "en",
  nav: {
    alerts: "Alerts",
    checks: "Checks",
    docs: "Docs",
    pages: "Status pages",
  },
  // The admin section waits for new screenshots; add "admin" back after "pages" to show it.
  order: ["checks", "alerts", "pages", "arabic", "server", "install"],
  other: "العربية",
  pages: {
    also: "Visitors follow it by",
    feeds: ["Email", "Webhook", "Atom feed", "JSON summary"],
    lead: "A status page for every service, kept honest by your monitors. Post an incident in a minute, schedule the maintenance, and let your visitors subscribe instead of emailing you.",
    title: "Answer the question *before it is asked*.",
  },
  server: {
    chart: {
      caption:
        "Container memory: 1,500 monitors checked every second, 77 thousand checks, on one core under a 240 MB limit. From the last benchmark run on {date}, on SQLite.",
      limit: "240 MB limit",
      title: "Memory under load",
    },
    figure:
      "Three parts in one process: the scheduler, the notification queue and the database, on one core.",
    figures: [
      ["1", "vCPU", "one core"],
      ["800", "monitors", "every 20 seconds in 107 MB"],
      ["0.4", "s", "from start to the first answer"],
      ["86", "MB", "one binary for Linux, macOS and Windows"],
      ["0", "outside services", "SQLite or Postgres, nothing else"],
    ],
    lead: "One process on your own server. No Redis, no queue to babysit, no monthly bill. Every release is measured in a container with one core and 240 MB before it ships.",
    title: "One core. *240 MB.* Nothing else to run.",
  },
  search: "Search the docs",
  copyCode: { copied: "Copied", copy: "Copy" },
  theme: "Dark theme",
  title: "Raaqeb",
  preview: "Raaqeb: a status page with its components and the latest checks",
};

export const copies: Readonly<Record<Locale, Copy>> = { ar, en };
