/**
 * The second e2e server: an install whose language is English, whose
 * appearance settings are all away from their defaults, and whose operator
 * account exists, so the specs can see the document follow the settings and
 * can sign in. Its default status page, seeded here, is what the bare host
 * shows the public spec. Playwright starts its web servers at once, so this one waits
 * for the Arabic server (which runs the build) before it seeds its own data
 * directory and serves the same build.
 */

import { authFor, operatorName } from "@/server/auth/auth.ts";
import { scratchInstallKey } from "@/server/boot/fixture.ts";
import { createIncident, postUpdate } from "@/server/incidents/incidents.ts";
import { createWindow } from "@/server/maintenance/maintenance.ts";
import { createComponent } from "@/server/pages/components.ts";
import { createPage, savePage } from "@/server/pages/pages.ts";
import { releaseCheckEnabled } from "@/server/release/release.ts";
import {
  appearanceDensity,
  appearanceFontSize,
  appearanceRadius,
  appearanceTheme,
} from "@/server/settings/appearance.ts";
import { gettingStartedClosed } from "@/server/settings/getting-started.ts";
import { installLanguage } from "@/server/settings/language.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import { defaultCustomization } from "@/shared/schemas/page.ts";
import { buildDir, builtMain } from "./built.ts";
import { seedMonitors } from "./monitors.ts";
import {
  noticesPage,
  operatorEmail,
  operatorPassword,
  publicPage,
  seededSubscriptions,
} from "./servers.ts";

/** Each seeded subscription's random token, and the one the spec knows it by. */
const subscriptionTokens = new Map<string, string>();

async function seedStatusPage(storage: Storage): Promise<void> {
  // Set by hand: a linked monitor of this install goes down once checked, and the page's level would follow the clock.
  const linked = await createComponent(storage, {
    description: { en: "The public docs site" },
    monitorIds: [],
    name: { en: publicPage.linkedComponent },
    status: "operational",
  });
  const hand = await createComponent(storage, {
    description: undefined,
    monitorIds: [],
    name: { ar: publicPage.handComponentArabic, en: publicPage.handComponent },
    status: "operational",
  });
  const page = await createPage(storage, {
    locale: "en",
    slug: publicPage.slug,
    title: publicPage.title,
  });
  if (!(linked.ok && hand.ok && page.ok)) {
    throw new Error("the status page could not be seeded");
  }
  await savePage(storage, page.page.id, {
    customDomain: undefined,
    customization: {
      ...defaultCustomization,
      description: { en: "Live status of the example services" },
      labels: { operational: { en: publicPage.operationalName } },
      // A yellow of the page's own, which as text on its tint would not read.
      statusColours: { degraded_performance: publicPage.degradedColour },
      theme: "light",
    },
    isDefault: true,
    layout: [
      { componentId: linked.component.id, kind: "component" },
      {
        componentIds: [hand.component.id],
        kind: "group",
        name: { en: "Platform" },
      },
    ],
    locale: "en",
    published: true,
    slug: publicPage.slug,
    title: { ar: publicPage.titleArabic, en: publicPage.title },
  });
  // Its subscribers, by email so no install key is needed: one in each state the subscription spec walks.
  const at = Date.now();
  for (const [each, locale, confirmed] of [
    [seededSubscriptions.pending, "en", false],
    [seededSubscriptions.arabic, "ar", true],
    [seededSubscriptions.oneClick, "en", true],
    [seededSubscriptions.removed, "en", false],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one sign-up after the other
    const stored = await storage.subscriptions.request({
      address: each.address,
      channel: "email",
      credentials: undefined,
      locale,
      pageId: page.page.id,
      quietSince: at - 1,
      requestedAt: at,
    });
    if (!stored) {
      throw new Error("the subscriptions could not be seeded");
    }
    subscriptionTokens.set(stored.token, each.token);
    if (confirmed) {
      await storage.subscriptions.confirm(stored.token, at, at - 1);
    }
  }
  await createIncident(
    storage,
    {
      impact: "minor",
      message: { en: "Some API calls are slow. We are looking into it." },
      stage: "investigating",
      statuses: [
        { componentId: hand.component.id, status: "degraded_performance" },
      ],
      title: { en: "Slow API responses" },
    },
    operatorEmail
  );
  // A second page with its own component and one confirmed subscriber, which the subscription spec's admin writes reach.
  const notices = await createComponent(storage, {
    description: undefined,
    monitorIds: [],
    name: { en: noticesPage.component },
    status: "operational",
  });
  const noticesStatus = await createPage(storage, {
    locale: "en",
    slug: noticesPage.slug,
    title: noticesPage.title,
  });
  if (!(notices.ok && noticesStatus.ok)) {
    throw new Error("the notices page could not be seeded");
  }
  await savePage(storage, noticesStatus.page.id, {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    layout: [{ componentId: notices.component.id, kind: "component" }],
    locale: "en",
    published: true,
    slug: noticesPage.slug,
    title: { en: noticesPage.title },
  });
  const reader = await storage.subscriptions.request({
    address: noticesPage.subscriber.address,
    channel: "email",
    credentials: undefined,
    locale: "en",
    pageId: noticesStatus.page.id,
    quietSince: at - 1,
    requestedAt: at,
  });
  if (!reader) {
    throw new Error("the notices subscriber could not be seeded");
  }
  subscriptionTokens.set(reader.token, noticesPage.subscriber.token);
  await storage.subscriptions.confirm(reader.token, at, at - 1);
  // The history's current month: a resolved incident and a completed window.
  const past = await createIncident(
    storage,
    {
      impact: "major",
      message: { en: "Search on the docs site returns nothing." },
      stage: "investigating",
      statuses: [
        { componentId: linked.component.id, status: "partial_outage" },
      ],
      title: { en: publicPage.resolvedIncident },
    },
    operatorEmail
  );
  if (!past.ok) {
    throw new Error("the resolved incident could not be seeded");
  }
  await postUpdate(
    storage,
    past.incident.id,
    { keep: false, message: { en: "Search works again." }, stage: "resolved" },
    operatorEmail
  );
  const now = Date.now();
  // A window's start may not be in the past through the module, so the repository writes this one.
  await storage.maintenance.create({
    componentIds: [linked.component.id],
    endsAt: now - 60_000,
    message: { en: "The database moved to a larger disk." },
    startsAt: now - 120_000,
    title: { en: publicPage.completedWindow },
  });
  await storage.maintenance.advance(now);
  await createWindow(
    storage,
    {
      componentIds: [linked.component.id],
      endsAt: now + 50 * 3_600_000,
      message: { en: "The docs site moves to a new host." },
      startsAt: now + 48 * 3_600_000,
      title: { en: "Docs migration" },
    },
    now
  );
}

const [, , arabicOrigin, port, dataDir] = Bun.argv;
if (!(arabicOrigin && port && dataDir)) {
  process.stderr.write(
    "usage: bun e2e/support/serve-en.ts <arabic origin> <port> <data dir>\n"
  );
  process.exit(2);
}

/** Resolves once the origin answers, or after two minutes. */
async function waitFor(origin: string, deadline: number): Promise<void> {
  if (Date.now() >= deadline) {
    return;
  }
  const up = await fetch(origin).then(
    (response) => response.ok,
    () => false
  );
  if (!up) {
    await Bun.sleep(500);
    return waitFor(origin, deadline);
  }
}

await waitFor(arabicOrigin, Date.now() + 120_000);

await Bun.$`rm -rf ${dataDir}`.quiet();
await Bun.$`mkdir -p ${dataDir}`.quiet();
const opened = await openStorage({
  backend: "sqlite",
  file: `${dataDir}/raaqeb.sqlite`,
});
if (!opened.ok) {
  process.stderr.write(`${opened.message}\n`);
  process.exit(1);
}
await opened.storage.settings.set(installLanguage, "en");
// Every appearance setting away from its default, so the document can be seen to follow them.
await opened.storage.settings.set(appearanceTheme, "dark");
await opened.storage.settings.set(appearanceFontSize, "large");
await opened.storage.settings.set(appearanceDensity, "compact");
await opened.storage.settings.set(appearanceRadius, "none");
// Past getting started: the list's density is measured as an operator who dismissed the checklist sees it; the onboarding spec walks the checklist.
await opened.storage.settings.set(gettingStartedClosed, true);
// The daily release check would ask api.github.com; the run sends nothing off the machine.
await opened.storage.settings.set(releaseCheckEnabled, false);
// The operator account, created the way onboarding does: on the server, through auth.api.
const auth = await authFor(opened.storage, {
  betterAuthSecrets: undefined,
  installKey: await scratchInstallKey(),
});
await auth.api.signUpEmail({
  body: {
    email: operatorEmail,
    name: operatorName,
    password: operatorPassword,
  },
});
await seedMonitors(opened.storage);
await seedStatusPage(opened.storage);
await opened.storage.close();
// The repository makes random tokens; the spec knows each subscription by a fixed one.
for (const [made, known] of subscriptionTokens) {
  // biome-ignore lint/performance/noAwaitInLoops: one row at a time
  await runSql(
    { backend: "sqlite", file: `${dataDir}/raaqeb.sqlite` },
    "UPDATE subscriptions SET token = ? WHERE token = ?",
    [known, made]
  );
}

// The peer is always 127.0.0.1 in the e2e run, so it is a trusted proxy here
// and each spec picks its own client address through x-forwarded-for; Better
// Auth's sign-in limit (3 per 10 s) is then per spec, not per run.
const main = await builtMain();
const running = await main(
  ["--port", port, "--data-dir", dataDir, "--trusted-proxies", "127.0.0.1"],
  {},
  buildDir
);
if (typeof running === "number") {
  process.exit(running);
}
