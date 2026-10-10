/**
 * The servers the e2e run starts (playwright.config.ts): the Arabic
 * default, which stays in onboarding for the whole run; an English install
 * with its operator account; a fresh install the onboarding spec walks to
 * the end, so no other spec depends on its state; an install with its
 * operator account and nothing else, which the export spec imports into;
 * and the webhook receiver the channels spec sends to.
 */
export const arabicPort = 3210;
export const englishPort = 3211;
export const freshPort = 3212;
export const sinkPort = 3213;
export const emptyPort = 3214;
export const arabicOrigin = `http://127.0.0.1:${arabicPort}`;
export const englishOrigin = `http://127.0.0.1:${englishPort}`;
export const freshOrigin = `http://127.0.0.1:${freshPort}`;
export const sinkOrigin = `http://127.0.0.1:${sinkPort}`;
export const emptyOrigin = `http://127.0.0.1:${emptyPort}`;

/** The operator account the English install is seeded with (e2e/support/serve-en.ts). */
export const operatorEmail = "operator@example.com";
export const operatorPassword = "correct horse battery";

/** The default status page the English install is seeded with: an English page with a group, an open incident, a scheduled window, and a resolved incident and a completed window in its history. */
export const publicPage = {
  completedWindow: "Database upgrade",
  /** The page's own colour for degraded performance, the level of its open incident and of one of its components. */
  degradedColour: "#eab308",
  handComponent: "Status API",
  /** The hand-set component's name in Arabic, its other locale; the linked one has none, so the Arabic view falls back to its English name. */
  handComponentArabic: "واجهة الحالة",
  linkedComponent: "Documentation",
  /** The page's own name for operational, written in English, its page language. */
  operationalName: "All good here",
  resolvedIncident: "Docs search outage",
  slug: "example",
  title: "Example status",
  /** The page's title in Arabic, the other locale of an English page. */
  titleArabic: "حالة المثال",
};

/** The subscriptions the English install's default page is seeded with, each with its own token (e2e/support/serve-en.ts). */
export const seededSubscriptions = {
  arabic: { address: "arabic@example.com", token: "e2e-arabic-token-00001" },
  oneClick: {
    address: "oneclick@example.com",
    token: "e2e-oneclick-token-001",
  },
  pending: { address: "reader@example.com", token: "e2e-pending-token-0001" },
  removed: { address: "removed@example.com", token: "e2e-removed-token-0001" },
} as const;

/** A second page of the English install, showing one component of its own, with one confirmed subscriber: the admin's writes on that component reach it (e2e/subscriptions.spec.ts). */
export const noticesPage = {
  component: "Subscriber notices",
  slug: "notices",
  subscriber: {
    address: "notices@example.com",
    token: "e2e-notices-token-0001",
  },
  title: "Notices status",
} as const;
