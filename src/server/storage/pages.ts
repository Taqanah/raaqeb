/**
 * The status pages repository (CONTEXT.md "Status page", "Component
 * group"): one row per page with its customization as JSON text,
 * its groups and the components it shows as rows beside it, and its logo,
 * favicon and cover as rows of their own so reading a page never reads an
 * image. A save replaces the page's fields and its whole layout in one
 * transaction; making a page the default takes that from any other in the
 * same write. Rows never leave this file.
 */
import { type SQL, sql } from "drizzle-orm";
import { localeSchema } from "@/shared/i18n/locale.ts";
import {
  componentsOf,
  type PageImage,
  type PageImageKind,
  type PageItem,
  type PageLayout,
  pageCustomizationSchema,
  pageImageKindSchema,
  pageImageKinds,
  type StatusPage,
  type StatusPageFields,
} from "@/shared/schemas/page.ts";
import type { Executor } from "./connection.ts";
import { contentText, storedContent } from "./content.ts";

/** A stored image with its bytes. */
export interface StoredImage extends PageImage {
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface PagesRepository {
  /** Whether any page is published, from one existence check. */
  anyPublished: () => Promise<boolean>;
  /** Every page's components by page id, each list in the page's order; a page showing none is absent. */
  componentsShown: () => Promise<Map<string, string[]>>;
  /** Stores a new page with an empty layout; making it the default takes that from any other. Answers it with its id. */
  create: (fields: StatusPageFields) => Promise<StatusPage>;
  /** The page with that id, or nothing. */
  find: (id: string) => Promise<StatusPage | undefined>;
  /** One image with its bytes, or nothing. */
  image: (
    pageId: string,
    kind: PageImageKind
  ) => Promise<StoredImage | undefined>;
  /** The page's images without their bytes, in the order of `pageImageKinds`. */
  images: (pageId: string) => Promise<PageImage[]>;
  /** The page's groups and components in order; empty for an unknown id. */
  layout: (pageId: string) => Promise<PageLayout>;
  /** Every page, in creation order. */
  list: () => Promise<StatusPage[]>;
  /** Deletes the page, its layout and its images; answers whether it existed. */
  remove: (id: string) => Promise<boolean>;
  /** Deletes one image; answers whether it existed. */
  removeImage: (pageId: string, kind: PageImageKind) => Promise<boolean>;
  /** Replaces the page's fields and its layout as one write; a component id that does not exist is skipped. Nothing when the id is unknown. */
  save: (
    id: string,
    fields: StatusPageFields,
    layout: PageLayout
  ) => Promise<StatusPage | undefined>;
  /** Stores or replaces one image; answers whether the page exists. */
  setImage: (pageId: string, image: StoredImage) => Promise<boolean>;
}

/** Thrown by a read when a stored page no longer fits its schema (its language, its customization, its title or a group's name, an image's kind); the message names the page. */
export class PageShapeError extends Error {
  readonly pageId: string;
  constructor(id: string) {
    super(`the stored status page ${id} does not fit its schema`);
    this.name = "PageShapeError";
    this.pageId = id;
  }
}

/** A page row as the driver answers it. */
interface PageRow {
  created_at: number;
  custom_domain: string | null;
  customization: string;
  id: string;
  is_default: number;
  locale: string;
  published: number;
  slug: string;
  title: string;
  updated_at: number;
}

/** A group row as the driver answers it. */
interface GroupRow {
  id: string;
  name: string;
  page_id: string;
  position: number;
}

/** A shown component as the driver answers it. */
interface EntryRow {
  component_id: string;
  group_id: string | null;
  page_id: string;
  position: number;
}

/** An image row as the driver answers it, its bytes left out by `images`. */
interface ImageRow {
  body?: Uint8Array;
  content_type: string;
  hash: string;
  kind: string;
}

/** Ids are UUIDv7 text generated here; `newId` is a parameter so a test can fix them. */
export function pagesRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): PagesRepository {
  const {
    componentGroups,
    components,
    pageComponents,
    pageImages,
    statusPages,
  } = executor.tables;
  const column = (name: string) => sql.identifier(name);

  const read = async (run: Executor, where: SQL) =>
    (
      await run.rows<PageRow>(
        sql`SELECT ${statusPages.id} AS id, ${statusPages.slug} AS slug, ${statusPages.title} AS title, ${statusPages.locale} AS locale, ${statusPages.customDomain} AS custom_domain, ${statusPages.isDefault} AS is_default, ${statusPages.published} AS published, ${statusPages.customization} AS customization, ${statusPages.createdAt} AS created_at, ${statusPages.updatedAt} AS updated_at FROM ${statusPages} ${where} ORDER BY ${statusPages.createdAt}, ${statusPages.id}`
      )
    ).map(pageOf);
  const findOne = async (run: Executor, id: string) =>
    (await read(run, sql`WHERE ${statusPages.id} = ${id}`))[0];

  /** Every layout the condition names, by page id. */
  const layouts = async (where: {
    entries: SQL;
    groups: SQL;
  }): Promise<Map<string, PageLayout>> => {
    const [groups, entries] = await Promise.all([
      executor.rows<GroupRow>(
        sql`SELECT ${componentGroups.id} AS id, ${componentGroups.pageId} AS page_id, ${componentGroups.name} AS name, ${componentGroups.position} AS position FROM ${componentGroups} ${where.groups}`
      ),
      executor.rows<EntryRow>(
        sql`SELECT ${pageComponents.pageId} AS page_id, ${pageComponents.componentId} AS component_id, ${pageComponents.groupId} AS group_id, ${pageComponents.position} AS position FROM ${pageComponents} ${where.entries}`
      ),
    ]);
    return layoutsOf(groups, entries);
  };

  /** The default page, if the page is to be it, is taken from any other first: the database allows one. */
  const takeDefault = (run: Executor, fields: StatusPageFields) =>
    fields.isDefault
      ? run.run(
          sql`UPDATE ${statusPages} SET ${column("is_default")} = 0 WHERE ${statusPages.isDefault} = 1`
        )
      : Promise.resolve(0);

  const writeLayout = async (
    run: Executor,
    pageId: string,
    layout: PageLayout
  ) => {
    await run.run(
      sql`DELETE FROM ${pageComponents} WHERE ${pageComponents.pageId} = ${pageId}`
    );
    await run.run(
      sql`DELETE FROM ${componentGroups} WHERE ${componentGroups.pageId} = ${pageId}`
    );
    // An id no component has is skipped by the select; each row goes in order, so a group exists before its members.
    const place = (componentId: string, groupId: string | null, at: number) =>
      run.run(
        sql`INSERT INTO ${pageComponents} (${column("page_id")}, ${column("component_id")}, ${column("group_id")}, ${column("position")}) SELECT ${pageId}, ${components.id}, ${groupId}, ${at} FROM ${components} WHERE ${components.id} = ${componentId}`
      );
    for (const [position, item] of layout.entries()) {
      if (item.kind === "component") {
        // biome-ignore lint/performance/noAwaitInLoops: one transaction's statements, in order
        await place(item.componentId, null, position);
        continue;
      }
      const groupId = newId();
      await run.run(
        sql`INSERT INTO ${componentGroups} (${column("id")}, ${column("page_id")}, ${column("name")}, ${column("position")}) VALUES (${groupId}, ${pageId}, ${contentText(item.name)}, ${position})`
      );
      for (const [member, componentId] of item.componentIds.entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: one transaction's statements, in order
        await place(componentId, groupId, member);
      }
    }
  };

  return {
    anyPublished: async () => {
      const rows = await executor.rows<{ one: number }>(
        sql`SELECT 1 AS one FROM ${statusPages} WHERE ${statusPages.published} = 1 LIMIT 1`
      );
      return rows.length > 0;
    },
    componentsShown: async () => {
      const shown = new Map<string, string[]>();
      for (const [pageId, layout] of await layouts({
        entries: sql``,
        groups: sql``,
      })) {
        const ids = componentsOf(layout);
        if (ids.length > 0) {
          shown.set(pageId, ids);
        }
      }
      return shown;
    },
    create: (fields) =>
      executor.transaction(async (tx) => {
        const id = newId();
        const time = now();
        await takeDefault(tx, fields);
        await tx.run(
          sql`INSERT INTO ${statusPages} (${column("id")}, ${column("slug")}, ${column("title")}, ${column("locale")}, ${column("custom_domain")}, ${column("is_default")}, ${column("published")}, ${column("customization")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${fields.slug}, ${contentText(fields.title)}, ${fields.locale}, ${fields.customDomain ?? null}, ${fields.isDefault ? 1 : 0}, ${fields.published ? 1 : 0}, ${JSON.stringify(fields.customization)}, ${time}, ${time})`
        );
        const created = await findOne(tx, id);
        if (!created) {
          throw new Error(`the status page ${id} was not stored`);
        }
        return created;
      }),
    find: (id) => findOne(executor, id),
    image: async (pageId, kind) => {
      const [row] = await executor.rows<ImageRow>(
        sql`SELECT ${pageImages.kind} AS kind, ${pageImages.contentType} AS content_type, ${pageImages.hash} AS hash, ${pageImages.body} AS body FROM ${pageImages} WHERE ${pageImages.pageId} = ${pageId} AND ${pageImages.kind} = ${kind}`
      );
      return (
        row && { ...imageOf(pageId, row), body: new Uint8Array(row.body ?? []) }
      );
    },
    images: async (pageId) => {
      const rows = await executor.rows<ImageRow>(
        sql`SELECT ${pageImages.kind} AS kind, ${pageImages.contentType} AS content_type, ${pageImages.hash} AS hash FROM ${pageImages} WHERE ${pageImages.pageId} = ${pageId}`
      );
      return rows
        .map((row) => imageOf(pageId, row))
        .toSorted(
          (a, b) =>
            pageImageKinds.indexOf(a.kind) - pageImageKinds.indexOf(b.kind)
        );
    },
    layout: async (pageId) =>
      (
        await layouts({
          entries: sql`WHERE ${pageComponents.pageId} = ${pageId}`,
          groups: sql`WHERE ${componentGroups.pageId} = ${pageId}`,
        })
      ).get(pageId) ?? [],
    list: () => read(executor, sql``),
    remove: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${statusPages} WHERE ${statusPages.id} = ${id}`
      )) > 0,
    removeImage: async (pageId, kind) =>
      (await executor.run(
        sql`DELETE FROM ${pageImages} WHERE ${pageImages.pageId} = ${pageId} AND ${pageImages.kind} = ${kind}`
      )) > 0,
    save: (id, fields, layout) =>
      executor.transaction(async (tx) => {
        if (!(await findOne(tx, id))) {
          return;
        }
        await takeDefault(tx, fields);
        await tx.run(
          sql`UPDATE ${statusPages} SET ${column("slug")} = ${fields.slug}, ${column("title")} = ${contentText(fields.title)}, ${column("locale")} = ${fields.locale}, ${column("custom_domain")} = ${fields.customDomain ?? null}, ${column("is_default")} = ${fields.isDefault ? 1 : 0}, ${column("published")} = ${fields.published ? 1 : 0}, ${column("customization")} = ${JSON.stringify(fields.customization)}, ${column("updated_at")} = ${now()} WHERE ${statusPages.id} = ${id}`
        );
        await writeLayout(tx, id, layout);
        return findOne(tx, id);
      }),
    setImage: async (pageId, image) =>
      (await executor.run(
        sql`INSERT INTO ${pageImages} (${column("page_id")}, ${column("kind")}, ${column("content_type")}, ${column("body")}, ${column("hash")}, ${column("updated_at")}) SELECT ${statusPages.id}, ${image.kind}, ${image.contentType}, ${image.body}, ${image.hash}, ${now()} FROM ${statusPages} WHERE ${statusPages.id} = ${pageId} ON CONFLICT (${column("page_id")}, ${column("kind")}) DO UPDATE SET ${column("content_type")} = excluded.content_type, ${column("body")} = excluded.body, ${column("hash")} = excluded.hash, ${column("updated_at")} = excluded.updated_at`
      )) > 0,
  };
}

/** Every page's layout from its groups and shown components: groups and ungrouped components by their shared top-level position, members by theirs. */
function layoutsOf(
  groups: readonly GroupRow[],
  entries: readonly EntryRow[]
): Map<string, PageLayout> {
  const members = new Map<string, EntryRow[]>();
  const top = new Map<string, { position: number; item: PageItem }[]>();
  const at = (pageId: string) => {
    const items = top.get(pageId) ?? [];
    top.set(pageId, items);
    return items;
  };
  for (const entry of entries) {
    if (entry.group_id === null) {
      at(entry.page_id).push({
        item: { componentId: entry.component_id, kind: "component" },
        position: entry.position,
      });
    } else {
      members.set(entry.group_id, [
        ...(members.get(entry.group_id) ?? []),
        entry,
      ]);
    }
  }
  for (const group of groups) {
    const name = storedContent(group.name);
    if (!name) {
      throw new PageShapeError(group.page_id);
    }
    at(group.page_id).push({
      item: {
        componentIds: (members.get(group.id) ?? [])
          .toSorted((a, b) => a.position - b.position)
          .map((entry) => entry.component_id),
        kind: "group",
        name,
      },
      position: group.position,
    });
  }
  return new Map(
    [...top].map(([pageId, items]) => [
      pageId,
      items
        .toSorted((a, b) => a.position - b.position)
        .map((each) => each.item),
    ])
  );
}

function pageOf(row: PageRow): StatusPage {
  const locale = localeSchema.safeParse(row.locale);
  const customization = pageCustomizationSchema.safeParse(
    parseJson(row.customization)
  );
  const title = storedContent(row.title);
  if (!(locale.success && customization.success && title)) {
    throw new PageShapeError(row.id);
  }
  return {
    createdAt: row.created_at,
    customDomain: row.custom_domain ?? undefined,
    customization: customization.data,
    id: row.id,
    isDefault: row.is_default !== 0,
    locale: locale.data,
    published: row.published !== 0,
    slug: row.slug,
    title,
    updatedAt: row.updated_at,
  };
}

function imageOf(pageId: string, row: ImageRow): PageImage {
  const kind = pageImageKindSchema.safeParse(row.kind);
  if (!kind.success) {
    throw new PageShapeError(pageId);
  }
  return { contentType: row.content_type, hash: row.hash, kind: kind.data };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
