import { afterEach, describe, expect, test } from "bun:test";
import { publicAddress } from "@/server/settings/address.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import { runSql } from "@/server/storage/fixture.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { defaultCustomization, type PageInput } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { createComponent } from "./components.ts";
import {
  checksEveryMinute,
  d0,
  hour,
  type PagesScratch,
  scratchPages,
  site,
} from "./fixture.ts";
import {
  createPage,
  deletePage,
  listPages,
  readPageEditor,
  savePage,
} from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

async function opened(): Promise<PagesScratch> {
  scratch = await scratchPages();
  return scratch;
}

async function created(
  install: PagesScratch,
  slug = "status"
): Promise<{ id: string; isDefault: boolean }> {
  const result = await createPage(install.storage, {
    locale: "ar",
    slug,
    title: "حالة الخدمات",
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.page;
}

function input(overrides: Partial<PageInput> = {}): PageInput {
  return {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    published: true,
    layout: [],
    locale: "ar",
    slug: "status",
    title: { ar: "حالة الخدمات" },
    ...overrides,
  };
}

async function component(
  install: PagesScratch,
  name: string,
  overrides: {
    monitorIds?: string[];
    status?: "operational" | "partial_outage";
  } = {}
): Promise<string> {
  const result = await createComponent(install.storage, {
    monitorIds: overrides.monitorIds ?? [],
    name: { ar: name },
    status: overrides.status ?? "operational",
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.component.id;
}

describe("creating a status page", () => {
  test("a new page starts with the defaults, an empty layout and no domain, and moves the change counter", async () => {
    const s = await opened();
    const before = await s.storage.changeCounter();
    const result = await createPage(s.storage, {
      locale: "en",
      slug: "status",
      title: "Status",
    });
    expect(result.ok && result.page).toMatchObject({
      customDomain: undefined,
      customization: defaultCustomization,
      locale: "en",
      slug: "status",
      title: { en: "Status" },
    });
    expect(await s.storage.changeCounter()).toBe(before + 1);
  });

  test("a new page starts unpublished; the install's first page becomes the default and the next does not", async () => {
    const s = await opened();
    const first = await createPage(s.storage, {
      locale: "ar",
      slug: "one",
      title: "One",
    });
    expect(first).toMatchObject({
      ok: true,
      page: { isDefault: true, published: false },
    });
    const second = await createPage(s.storage, {
      locale: "en",
      slug: "two",
      title: "Two",
    });
    expect(second).toMatchObject({
      ok: true,
      page: { isDefault: false, published: false },
    });
  });

  test("a new page becomes the default when the install has none, as after the default was deleted", async () => {
    const s = await opened();
    const first = await created(s, "one");
    await created(s, "two");
    await deletePage(s.storage, first.id);
    expect((await created(s, "three")).isDefault).toBe(true);
  });

  test("a slug another page has is refused and nothing is stored", async () => {
    const s = await opened();
    await created(s, "status");
    const before = await s.storage.changeCounter();
    expect(
      await createPage(s.storage, { locale: "ar", slug: "status", title: "x" })
    ).toEqual({ ok: false, reason: "slug_taken" });
    expect(await s.storage.changeCounter()).toBe(before);
  });
});

describe("saving a status page", () => {
  test("a save replaces the fields, the customization and the layout, and moves the change counter", async () => {
    const s = await opened();
    const page = await created(s);
    const web = await component(s, "Web");
    const api = await component(s, "API");
    const customization = {
      ...defaultCustomization,
      brandColour: "#0f766e",
      noindex: true,
    };
    const before = await s.storage.changeCounter();
    const result = await savePage(
      s.storage,
      page.id,
      input({
        customDomain: "status.example.test",
        customization,
        isDefault: true,
        published: true,
        layout: [
          { componentId: web, kind: "component" },
          {
            componentIds: [api],
            kind: "group",
            name: { ar: "الخدمات", en: "Services" },
          },
        ],
        locale: "en",
        slug: "main",
        title: { ar: "الرئيسية", en: "Main" },
      })
    );
    expect(result.ok && result.page).toMatchObject({
      customDomain: "status.example.test",
      customization,
      id: page.id,
      isDefault: true,
      published: true,
      locale: "en",
      slug: "main",
      title: { ar: "الرئيسية", en: "Main" },
    });
    expect(await s.storage.pages.layout(page.id)).toEqual([
      { componentId: web, kind: "component" },
      {
        componentIds: [api],
        kind: "group",
        name: { ar: "الخدمات", en: "Services" },
      },
    ]);
    expect(await s.storage.changeCounter()).toBe(before + 1);
  });

  test("publishing and unpublishing are saves that store the switch and move the change counter", async () => {
    const s = await opened();
    const page = await created(s);
    for (const published of [true, false]) {
      // biome-ignore lint/performance/noAwaitInLoops: one save after the other
      const before = await s.storage.changeCounter();
      const saved = await savePage(s.storage, page.id, input({ published }));
      expect(saved.ok && saved.page.published).toBe(published);
      expect((await s.storage.pages.find(page.id))?.published).toBe(published);
      expect(await s.storage.changeCounter()).toBe(before + 1);
    }
  });

  test("a page keeps its own slug and domain on a save", async () => {
    const s = await opened();
    const page = await created(s);
    const first = await savePage(
      s.storage,
      page.id,
      input({ customDomain: "status.example.test" })
    );
    expect(first.ok).toBe(true);
    const again = await savePage(
      s.storage,
      page.id,
      input({ customDomain: "status.example.test", title: { ar: "Again" } })
    );
    expect(again.ok).toBe(true);
  });

  test("a slug another page has is refused", async () => {
    const s = await opened();
    await created(s, "one");
    const two = await created(s, "two");
    expect(await savePage(s.storage, two.id, input({ slug: "one" }))).toEqual({
      ok: false,
      reason: "slug_taken",
    });
  });

  test("a custom domain another page has is refused", async () => {
    const s = await opened();
    const one = await created(s, "one");
    const two = await created(s, "two");
    await savePage(
      s.storage,
      one.id,
      input({ customDomain: "status.example.test", slug: "one" })
    );
    expect(
      await savePage(
        s.storage,
        two.id,
        input({ customDomain: "status.example.test", slug: "two" })
      )
    ).toEqual({ ok: false, reason: "domain_taken" });
  });

  test.each([
    "https://status.raaqeb.test",
    "http://status.raaqeb.test:8080",
    "https://status.raaqeb.test.",
  ])(
    "the public address's host is refused as a custom domain, whatever port or trailing dot the address carries (%s)",
    async (address) => {
      const s = await opened();
      await s.storage.settings.set(publicAddress, address);
      const page = await created(s);
      expect(
        await savePage(
          s.storage,
          page.id,
          input({ customDomain: "status.raaqeb.test" })
        )
      ).toEqual({ ok: false, reason: "domain_public_address" });
      expect(
        (
          await savePage(
            s.storage,
            page.id,
            input({ customDomain: "raaqeb.test" })
          )
        ).ok
      ).toBe(true);
    }
  );

  test("making a page the default takes that from the page that was", async () => {
    const s = await opened();
    const one = await created(s, "one");
    const two = await created(s, "two");
    await savePage(s.storage, two.id, input({ isDefault: true, slug: "two" }));
    expect((await s.storage.pages.find(one.id))?.isDefault).toBe(false);
    expect((await s.storage.pages.find(two.id))?.isDefault).toBe(true);
  });

  test("a save of an unknown page is not found and moves nothing", async () => {
    const s = await opened();
    const before = await s.storage.changeCounter();
    expect(await savePage(s.storage, "nope", input())).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await s.storage.changeCounter()).toBe(before);
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const s = await opened();
    const page = await created(s);
    await s.cleanup();
    scratch = undefined;
    expect(await savePage(s.storage, page.id, input())).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("the page list", () => {
  test("each page shows its status level, the worst of the components it shows, and how many it shows", async () => {
    const s = await opened();
    const monitor = await s.storage.monitors.create(site);
    await checksEveryMinute(s.storage, monitor, d0, d0 + hour, "down");
    await s.storage.outages.open(monitor.id, d0, reasons.timeout);
    const down = await component(s, "Down", { monitorIds: [monitor.id] });
    const partial = await component(s, "Partial", { status: "partial_outage" });
    const fine = await component(s, "Fine");
    s.at(d0 + 1);
    const one = await created(s, "one");
    s.at(d0 + 2);
    const two = await created(s, "two");
    s.at(d0 + 3);
    const empty = await created(s, "three");
    await savePage(
      s.storage,
      one.id,
      input({
        isDefault: true,
        published: true,
        layout: [
          { componentId: fine, kind: "component" },
          { componentIds: [down], kind: "group", name: { ar: "G" } },
        ],
        slug: "one",
      })
    );
    await savePage(
      s.storage,
      two.id,
      input({
        layout: [
          { componentId: fine, kind: "component" },
          { componentId: partial, kind: "component" },
        ],
        slug: "two",
      })
    );
    const listed = await listPages(s.storage);
    if (!listed.ok) {
      throw new Error(listed.reason);
    }
    expect(
      listed.pages.map((item) => [item.page.id, item.level, item.components])
    ).toEqual([
      [one.id, "major_outage", 2],
      [two.id, "partial_outage", 2],
      [empty.id, "operational", 0],
    ]);
  });

  test("a stored page this version cannot read is named", async () => {
    const s = await opened();
    const page = await created(s);
    await runSql(
      s.location,
      "UPDATE status_pages SET locale = ? WHERE id = ?",
      ["fr", page.id]
    );
    expect(await listPages(s.storage)).toEqual({
      id: page.id,
      ok: false,
      reason: "corrupt",
    });
  });
});

describe("the page editor's read", () => {
  test("the editor reads the page, its layout, its images and every component with its status now", async () => {
    const s = await opened();
    const web = await component(s, "Web", { status: "partial_outage" });
    s.at(d0 + 1);
    const api = await component(s, "API");
    const page = await created(s);
    await savePage(
      s.storage,
      page.id,
      input({ layout: [{ componentId: web, kind: "component" }] })
    );
    await s.storage.pages.setImage(page.id, {
      body: new Uint8Array([1]),
      contentType: "image/png",
      hash: "abc",
      kind: "logo",
    });
    const editor = await readPageEditor(s.storage, page.id);
    if (!editor.ok) {
      throw new Error(editor.reason);
    }
    expect(editor.editor.page.id).toBe(page.id);
    expect(editor.editor.layout).toEqual([
      { componentId: web, kind: "component" },
    ]);
    expect(editor.editor.images).toEqual([
      { contentType: "image/png", hash: "abc", kind: "logo" },
    ]);
    expect(editor.editor.components).toEqual([
      { id: web, name: { ar: "Web" }, status: "partial_outage" },
      { id: api, name: { ar: "API" }, status: "operational" },
    ]);
  });

  test("the editor reads each status level's own name in every locale, for the names a page leaves empty", async () => {
    const s = await opened();
    const page = await created(s, "status");
    const editor = await readPageEditor(s.storage, page.id);
    expect(editor.ok && editor.editor.statusNames.ar.operational).toBe(
      createMessages("ar", await loadCatalog("ar"))._(
        "component_level_operational"
      )
    );
    expect(editor.ok && editor.editor.statusNames.en.major_outage).toBe(
      createMessages("en", await loadCatalog("en"))._(
        "component_level_major_outage"
      )
    );
  });

  test("an unknown page's editor is not found", async () => {
    const s = await opened();
    expect(await readPageEditor(s.storage, "nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("deleting a status page", () => {
  test("a delete takes the page away and moves the change counter; a second is not found", async () => {
    const s = await opened();
    const page = await created(s);
    const before = await s.storage.changeCounter();
    expect(await deletePage(s.storage, page.id)).toEqual({ ok: true });
    expect(await s.storage.pages.find(page.id)).toBeUndefined();
    expect(await s.storage.changeCounter()).toBe(before + 1);
    expect(await deletePage(s.storage, page.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
