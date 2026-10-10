import { afterEach, describe, expect, test } from "bun:test";
import {
  defaultCustomization,
  type PageLayout,
  type StatusPageFields,
} from "@/shared/schemas/page.ts";
import {
  type ComponentsRepository,
  componentsRepository,
} from "./components.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import {
  PageShapeError,
  type PagesRepository,
  pagesRepository,
  type StoredImage,
} from "./pages.ts";
import type { DatabaseLocation } from "./storage.ts";

let open: { cleanup: () => Promise<void>; connection: Connection } | undefined;

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const t0 = 1_700_000_000_000;

async function repositories(): Promise<{
  components: ComponentsRepository;
  location: DatabaseLocation;
  pages: PagesRepository;
  tick: (ms: number) => void;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  const run = executor(connection);
  let time = t0;
  const now = () => time;
  return {
    components: componentsRepository(run, now),
    location: scratch.location,
    pages: pagesRepository(run, now),
    tick: (ms) => {
      time += ms;
    },
  };
}

function page(overrides: Partial<StatusPageFields> = {}): StatusPageFields {
  return {
    customDomain: undefined,
    customization: defaultCustomization,
    isDefault: false,
    published: true,
    locale: "ar",
    slug: "status",
    title: { ar: "حالة الخدمات" },
    ...overrides,
  };
}

async function threeComponents(components: ComponentsRepository) {
  const make = (name: string) =>
    components.create({
      description: undefined,
      monitorIds: [],
      name: { ar: name },
      status: "operational",
    });
  return {
    api: (await make("API")).id,
    store: (await make("Store")).id,
    web: (await make("Web")).id,
  };
}

function png(bytes: number[]): StoredImage {
  return {
    body: new Uint8Array(bytes),
    contentType: "image/png",
    hash: `hash-${bytes.join("")}`,
    kind: "logo",
  };
}

describe("the status pages repository", () => {
  test("a page is stored with its slug, title, language, domain, default flag and customization, and read back whole", async () => {
    const { pages } = await repositories();
    const customization = {
      ...defaultCustomization,
      brandColour: "#0f766e",
      footerLinks: [
        { label: { ar: "المساعدة" }, url: "https://example.test/help" },
      ],
      labels: { operational: { ar: "كل شيء يعمل" } },
    };
    const created = await pages.create(
      page({
        customDomain: "status.example.test",
        customization,
        isDefault: true,
        published: true,
        locale: "en",
      })
    );
    expect(created).toEqual({
      createdAt: t0,
      customDomain: "status.example.test",
      customization,
      id: created.id,
      isDefault: true,
      published: true,
      locale: "en",
      slug: "status",
      title: { ar: "حالة الخدمات" },
      updatedAt: t0,
    });
    expect(await pages.find(created.id)).toEqual(created);
    expect(await pages.layout(created.id)).toEqual([]);
  });

  test("the list holds every page in creation order", async () => {
    const { pages, tick } = await repositories();
    const first = await pages.create(page({ slug: "one" }));
    tick(1);
    const second = await pages.create(page({ slug: "two" }));
    expect(await pages.list()).toEqual([first, second]);
  });

  test("a second page with the same slug or the same custom domain is refused by the database", async () => {
    const { pages } = await repositories();
    await pages.create(page({ customDomain: "status.example.test" }));
    await expect(pages.create(page({ slug: "status" }))).rejects.toThrow();
    await expect(
      pages.create(page({ customDomain: "status.example.test", slug: "other" }))
    ).rejects.toThrow();
    // Many pages have no custom domain.
    await pages.create(page({ slug: "two" }));
    await pages.create(page({ slug: "three" }));
    expect(await pages.list()).toHaveLength(3);
  });

  test("making a page the default takes that from the page that was, at create and at save", async () => {
    const { pages } = await repositories();
    const first = await pages.create(page({ isDefault: true, slug: "one" }));
    const second = await pages.create(page({ isDefault: true, slug: "two" }));
    expect((await pages.find(first.id))?.isDefault).toBe(false);
    expect(second.isDefault).toBe(true);
    await pages.save(first.id, { ...first, isDefault: true }, []);
    expect((await pages.find(first.id))?.isDefault).toBe(true);
    expect((await pages.find(second.id))?.isDefault).toBe(false);
  });

  test("a page is stored published or unpublished, and a save switches it either way", async () => {
    const { pages } = await repositories();
    const draft = await pages.create(page({ published: false }));
    expect(draft.published).toBe(false);
    expect((await pages.find(draft.id))?.published).toBe(false);
    await pages.save(draft.id, { ...draft, published: true }, []);
    expect((await pages.find(draft.id))?.published).toBe(true);
    await pages.save(draft.id, { ...draft, published: false }, []);
    expect((await pages.list()).map((each) => each.published)).toEqual([false]);
  });

  test("an install has a published page only once a page is published, and not after it is unpublished", async () => {
    const { pages } = await repositories();
    expect(await pages.anyPublished()).toBe(false);
    const draft = await pages.create(page({ published: false }));
    expect(await pages.anyPublished()).toBe(false);
    await pages.save(draft.id, { ...draft, published: true }, []);
    expect(await pages.anyPublished()).toBe(true);
    await pages.create(page({ published: false, slug: "other" }));
    expect(await pages.anyPublished()).toBe(true);
    await pages.save(draft.id, { ...draft, published: false }, []);
    expect(await pages.anyPublished()).toBe(false);
  });

  test("a save that turns the default off leaves the install with no default page", async () => {
    const { pages } = await repositories();
    const created = await pages.create(page({ isDefault: true }));
    await pages.save(created.id, { ...created, isDefault: false }, []);
    expect((await pages.list()).some((each) => each.isDefault)).toBe(false);
  });

  test("the database refuses a second default page written around the repository", async () => {
    const { location, pages } = await repositories();
    await pages.create(page({ isDefault: true, slug: "one" }));
    const second = await pages.create(page({ slug: "two" }));
    await expect(
      runSql(location, "UPDATE status_pages SET is_default = 1 WHERE id = ?", [
        second.id,
      ])
    ).rejects.toThrow();
  });

  test("a save replaces the fields and the whole layout, keeping the id and the creation time", async () => {
    const { components, pages, tick } = await repositories();
    const { api, store, web } = await threeComponents(components);
    const created = await pages.create(page());
    const layout: PageLayout = [
      { componentId: web, kind: "component" },
      { componentIds: [store, api], kind: "group", name: { ar: "الخدمات" } },
    ];
    tick(1000);
    const saved = await pages.save(
      created.id,
      page({ slug: "main", title: { ar: "Main" } }),
      layout
    );
    expect(saved).toEqual({
      ...created,
      slug: "main",
      title: { ar: "Main" },
      updatedAt: t0 + 1000,
    });
    expect(await pages.layout(created.id)).toEqual(layout);
    await pages.save(created.id, page(), [
      { componentId: api, kind: "component" },
    ]);
    expect(await pages.layout(created.id)).toEqual([
      { componentId: api, kind: "component" },
    ]);
  });

  test("groups and ungrouped components share one top-level order, and each group keeps its own", async () => {
    const { components, pages } = await repositories();
    const { api, store, web } = await threeComponents(components);
    const created = await pages.create(page());
    const layout: PageLayout = [
      { componentIds: [api], kind: "group", name: { ar: "B" } },
      { componentId: web, kind: "component" },
      { componentIds: [], kind: "group", name: { ar: "Empty" } },
      { componentIds: [store], kind: "group", name: { ar: "A" } },
    ];
    await pages.save(created.id, page(), layout);
    expect(await pages.layout(created.id)).toEqual(layout);
  });

  test("a component id that does not exist is skipped on save", async () => {
    const { components, pages } = await repositories();
    const { web } = await threeComponents(components);
    const created = await pages.create(page());
    await pages.save(created.id, page(), [
      { componentId: "gone", kind: "component" },
      { componentIds: ["gone-too", web], kind: "group", name: { ar: "G" } },
    ]);
    expect(await pages.layout(created.id)).toEqual([
      { componentIds: [web], kind: "group", name: { ar: "G" } },
    ]);
  });

  test("a save of an unknown page changes nothing and answers nothing, the default page included", async () => {
    const { components, pages } = await repositories();
    const { web } = await threeComponents(components);
    const created = await pages.create(page({ isDefault: true }));
    expect(
      await pages.save("nope", page({ isDefault: true, slug: "other" }), [
        { componentIds: [web], kind: "group", name: { ar: "G" } },
      ])
    ).toBeUndefined();
    expect(await pages.list()).toEqual([created]);
    expect(await pages.componentsShown()).toEqual(new Map());
  });

  test("every page's components are listed by page, in each page's order; a page showing none is absent", async () => {
    const { components, pages } = await repositories();
    const { api, store, web } = await threeComponents(components);
    const one = await pages.create(page({ slug: "one" }));
    const two = await pages.create(page({ slug: "two" }));
    const three = await pages.create(page({ slug: "three" }));
    await pages.save(three.id, page({ slug: "three" }), [
      { componentIds: [], kind: "group", name: { ar: "Empty" } },
    ]);
    await pages.save(one.id, page({ slug: "one" }), [
      { componentIds: [store], kind: "group", name: { ar: "G" } },
      { componentId: web, kind: "component" },
    ]);
    await pages.save(two.id, page({ slug: "two" }), [
      { componentId: web, kind: "component" },
      { componentId: api, kind: "component" },
    ]);
    expect(await pages.componentsShown()).toEqual(
      new Map([
        [one.id, [store, web]],
        [two.id, [web, api]],
      ])
    );
  });

  test("an image is stored with its bytes and read back; the list of a page's images carries no bytes", async () => {
    const { pages } = await repositories();
    const created = await pages.create(page());
    const logo = png([137, 80, 78, 71]);
    expect(await pages.setImage(created.id, logo)).toBe(true);
    const favicon: StoredImage = {
      body: new Uint8Array([0, 0, 1, 0]),
      contentType: "image/x-icon",
      hash: "fav",
      kind: "favicon",
    };
    await pages.setImage(created.id, favicon);
    expect(await pages.image(created.id, "logo")).toEqual(logo);
    expect(await pages.images(created.id)).toEqual([
      { contentType: "image/png", hash: logo.hash, kind: "logo" },
      { contentType: "image/x-icon", hash: "fav", kind: "favicon" },
    ]);
  });

  test("a new image of the same kind replaces the old one", async () => {
    const { pages } = await repositories();
    const created = await pages.create(page());
    await pages.setImage(created.id, png([1]));
    await pages.setImage(created.id, png([2, 3]));
    expect(await pages.image(created.id, "logo")).toEqual(png([2, 3]));
    expect(await pages.images(created.id)).toHaveLength(1);
  });

  test("an image for an unknown page is not stored", async () => {
    const { pages } = await repositories();
    expect(await pages.setImage("nope", png([1]))).toBe(false);
    expect(await pages.image("nope", "logo")).toBeUndefined();
  });

  test("removing an image says whether there was one", async () => {
    const { pages } = await repositories();
    const created = await pages.create(page());
    await pages.setImage(created.id, png([1]));
    expect(await pages.removeImage(created.id, "logo")).toBe(true);
    expect(await pages.removeImage(created.id, "logo")).toBe(false);
    expect(await pages.image(created.id, "logo")).toBeUndefined();
  });

  test("deleting a page takes its layout, its groups and its images with it, and leaves the components", async () => {
    const { components, location, pages } = await repositories();
    const { web } = await threeComponents(components);
    const created = await pages.create(page());
    await pages.save(created.id, page(), [
      { componentIds: [web], kind: "group", name: { ar: "G" } },
    ]);
    await pages.setImage(created.id, png([1]));
    expect(await pages.remove(created.id)).toBe(true);
    expect(await pages.remove(created.id)).toBe(false);
    expect(await pages.find(created.id)).toBeUndefined();
    const counts = await Promise.all(
      ["component_groups", "page_components", "page_images"].map(
        async (table) =>
          (await runSql(location, `SELECT COUNT(*) AS n FROM ${table}`))[0]?.n
      )
    );
    expect(counts.map(Number)).toEqual([0, 0, 0]);
    expect(await components.find(web)).toBeDefined();
  });

  test("a stored customization or language this version cannot read is a shape error naming the page", async () => {
    const { location, pages } = await repositories();
    const created = await pages.create(page());
    await runSql(
      location,
      "UPDATE status_pages SET customization = ? WHERE id = ?",
      ['{"barDays": 45}', created.id]
    );
    const read = await pages.find(created.id).catch((error) => error);
    expect(read).toBeInstanceOf(PageShapeError);
    expect(read.pageId).toBe(created.id);
    await runSql(
      location,
      "UPDATE status_pages SET customization = ?, locale = ? WHERE id = ?",
      ["{}", "fr", created.id]
    );
    expect(await pages.list().catch((error) => error)).toBeInstanceOf(
      PageShapeError
    );
  });

  test("a stored title or group name that is not content is a shape error naming the page", async () => {
    const { location, pages } = await repositories();
    const created = await pages.create(page());
    await runSql(location, "UPDATE status_pages SET title = ? WHERE id = ?", [
      "حالة الخدمات",
      created.id,
    ]);
    const read = await pages.find(created.id).catch((error) => error);
    expect(read).toBeInstanceOf(PageShapeError);
    expect(read.pageId).toBe(created.id);
    await runSql(location, "UPDATE status_pages SET title = ? WHERE id = ?", [
      '{"ar":"حالة الخدمات"}',
      created.id,
    ]);
    await pages.save(created.id, created, [
      { componentIds: [], kind: "group", name: { ar: "الأساس" } },
    ]);
    await runSql(location, "UPDATE component_groups SET name = ?", ["الأساس"]);
    const layout = await pages.layout(created.id).catch((error) => error);
    expect(layout).toBeInstanceOf(PageShapeError);
    expect(layout.pageId).toBe(created.id);
  });

  test("a stored image of a kind this version does not know is a shape error naming the page", async () => {
    const { location, pages } = await repositories();
    const created = await pages.create(page());
    await pages.setImage(created.id, png([1]));
    await runSql(location, "UPDATE page_images SET kind = ?", ["banner"]);
    expect(
      await pages.images(created.id).catch((error) => error)
    ).toBeInstanceOf(PageShapeError);
  });
});
