import { describe, expect, test } from "bun:test";
import {
  defaultCustomization,
  type PageEditor,
} from "@/shared/schemas/page.ts";
import {
  addComponent,
  addGroup,
  type DraftItem,
  groupOf,
  moveComponentTo,
  moveEntry,
  newPageInputOf,
  type PageDraft,
  pageDraftOf,
  pageInputOf,
  placedComponents,
  removeComponent,
  removeGroup,
  renameGroup,
} from "./page-draft.ts";

const editor: PageEditor = {
  components: [
    { id: "web", name: { ar: "Web" }, status: "operational" },
    { id: "api", name: { ar: "API" }, status: "partial_outage" },
    { id: "db", name: { ar: "DB" }, status: "operational" },
  ],
  images: [],
  layout: [
    { componentId: "web", kind: "component" },
    { componentIds: ["api", "db"], kind: "group", name: { ar: "الخدمات" } },
  ],
  page: {
    createdAt: 1,
    customDomain: "status.example.test",
    customization: {
      ...defaultCustomization,
      brandColour: "#0f766e",
      footerLinks: [
        { label: { ar: "المساعدة" }, url: "https://example.test/help" },
      ],
      labels: { operational: { ar: "كل شيء يعمل" } },
      statusColours: { major_outage: "#b91c1c" },
    },
    id: "p1",
    isDefault: true,
    published: true,
    locale: "ar",
    slug: "status",
    title: { ar: "حالة الخدمات" },
    updatedAt: 2,
  },
  statusNames: {
    ar: {
      degraded_performance: "",
      major_outage: "",
      operational: "",
      partial_outage: "",
      under_maintenance: "",
    },
    en: {
      degraded_performance: "",
      major_outage: "",
      operational: "",
      partial_outage: "",
      under_maintenance: "",
    },
  },
};

/** The key the draft gave the stored page's one group. */
function onlyGroupKey(layout: readonly DraftItem[]): string {
  const group = layout.find((item) => item.kind === "group");
  if (group?.kind !== "group") {
    throw new Error("no group");
  }
  return group.key;
}

/** Nothing typed in any locale. */
const none = { ar: "", en: "" };

/** Text typed in Arabic alone. */
const arabic = (text: string) => ({ ar: text, en: "" });

describe("the page editor's draft", () => {
  test("the draft carries every field as typed, each piece of content in each locale, empty where the page has nothing", () => {
    const draft = pageDraftOf(editor);
    expect(draft).toMatchObject({
      barDays: 90,
      bars: true,
      brandColour: "#0f766e",
      contactUrl: "",
      customCss: "",
      customDomain: "status.example.test",
      description: none,
      isDefault: true,
      published: true,
      labels: {
        degraded_performance: none,
        major_outage: none,
        operational: arabic("كل شيء يعمل"),
        partial_outage: none,
        under_maintenance: none,
      },
      locale: "ar",
      noindex: false,
      percentages: true,
      poweredBy: true,
      slug: "status",
      statusColours: {
        degraded_performance: "",
        major_outage: "#b91c1c",
        operational: "",
        partial_outage: "",
        under_maintenance: "",
      },
      subscriptions: ["email", "webhook"],
      theme: "system",
      title: arabic("حالة الخدمات"),
    });
    expect(draft.footerLinks).toMatchObject([
      { label: arabic("المساعدة"), url: "https://example.test/help" },
    ]);
    expect(draft.layout[1]).toMatchObject({ name: arabic("الخدمات") });
    expect(placedComponents(draft.layout)).toEqual(["web", "api", "db"]);
  });

  test("an untouched draft posts the stored page back unchanged", () => {
    const { page } = editor;
    expect(pageInputOf(pageDraftOf(editor))).toEqual({
      input: {
        customDomain: page.customDomain,
        customization: page.customization,
        isDefault: page.isDefault,
        published: true,
        layout: [
          { componentId: "web", kind: "component" },
          {
            componentIds: ["api", "db"],
            kind: "group",
            name: { ar: "الخدمات" },
          },
        ],
        locale: page.locale,
        slug: page.slug,
        title: page.title,
      },
      ok: true,
    });
  });

  test("the published switch is read from the page and posts as the operator left it", () => {
    const draft = pageDraftOf({
      ...editor,
      page: { ...editor.page, published: false },
    });
    expect(draft.published).toBe(false);
    for (const published of [false, true]) {
      const parsed = pageInputOf({ ...draft, published });
      expect(parsed).toMatchObject({ input: { published }, ok: true });
    }
  });

  test("an empty field posts as absent: the domain, the description, the colours, the labels, the contact link, the CSS", () => {
    const draft: PageDraft = {
      ...pageDraftOf(editor),
      brandColour: "",
      contactUrl: " ",
      customCss: "",
      customDomain: "  ",
      description: none,
      labels: { ...pageDraftOf(editor).labels, operational: arabic(" ") },
      statusColours: { ...pageDraftOf(editor).statusColours, major_outage: "" },
    };
    const parsed = pageInputOf(draft);
    expect(parsed.ok && parsed.input.customDomain).toBeUndefined();
    expect(parsed.ok && parsed.input.customization).toEqual({
      ...defaultCustomization,
      footerLinks: [
        { label: { ar: "المساعدة" }, url: "https://example.test/help" },
      ],
    });
  });

  test("each locale's text posts on its own, an empty one left out", () => {
    const parsed = pageInputOf({
      ...pageDraftOf(editor),
      description: { ar: "حالة خدماتنا", en: "Our services" },
      labels: {
        ...pageDraftOf(editor).labels,
        major_outage: { ar: "", en: "Down" },
      },
      title: { ar: "حالة الخدمات", en: " Service status " },
    });
    expect(parsed.ok && parsed.input.title).toEqual({
      ar: "حالة الخدمات",
      en: "Service status",
    });
    expect(parsed.ok && parsed.input.customization.description).toEqual({
      ar: "حالة خدماتنا",
      en: "Our services",
    });
    // A status name stands alone in each locale: the other locale's name with no page language's is kept.
    expect(parsed.ok && parsed.input.customization.labels).toEqual({
      major_outage: { en: "Down" },
      operational: { ar: "كل شيء يعمل" },
    });
  });

  test("a title, a description, a footer link's label or a group's name without the page language's text is refused on its field", () => {
    const draft = pageDraftOf(editor);
    const key = onlyGroupKey(draft.layout);
    expect(
      pageInputOf({
        ...draft,
        description: { ar: "", en: "Our services" },
        footerLinks: [
          {
            key: "x",
            label: { ar: "", en: "Help" },
            url: "https://example.test/help",
          },
        ],
        layout: renameGroup(draft.layout, key, { ar: " ", en: "Services" }),
        title: { ar: "", en: "Service status" },
      })
    ).toEqual({
      errors: {
        "customization.description": "page_refused_description",
        "customization.footerLinks.0.label":
          "page_refused_footer_label_missing",
        [`layout.${key}`]: "page_refused_group",
        title: "page_refused_title",
      },
      ok: false,
    });
  });

  test("a footer link's label past 40 characters is refused for its length, not as missing", () => {
    const draft = pageDraftOf(editor);
    expect(
      pageInputOf({
        ...draft,
        footerLinks: [
          {
            key: "x",
            label: arabic("ن".repeat(41)),
            url: "https://example.test/help",
          },
        ],
      })
    ).toEqual({
      errors: {
        "customization.footerLinks.0.label": "page_refused_footer_label",
      },
      ok: false,
    });
  });

  test("changing the page language asks for the new language's text", () => {
    expect(pageInputOf({ ...pageDraftOf(editor), locale: "en" })).toMatchObject(
      { errors: { title: "page_refused_title" }, ok: false }
    );
  });

  test("a footer link row left empty is not posted; a row half filled is refused", () => {
    const draft = pageDraftOf(editor);
    const withEmpty: PageDraft = {
      ...draft,
      footerLinks: [
        ...draft.footerLinks,
        { key: "new", label: arabic(" "), url: "" },
      ],
    };
    const parsed = pageInputOf(withEmpty);
    expect(parsed.ok && parsed.input.customization.footerLinks).toHaveLength(1);
    const half: PageDraft = {
      ...draft,
      footerLinks: [{ key: "x", label: arabic("الدعم"), url: "" }],
    };
    expect(pageInputOf(half)).toEqual({
      errors: { "customization.footerLinks.0.url": "page_refused_link" },
      ok: false,
    });
    // An empty row before it is not posted, and the refusal still names the row the editor shows.
    const afterEmpty: PageDraft = {
      ...draft,
      footerLinks: [
        { key: "empty", label: none, url: " " },
        { key: "x", label: arabic("الدعم"), url: "" },
      ],
    };
    expect(pageInputOf(afterEmpty)).toEqual({
      errors: { "customization.footerLinks.1.url": "page_refused_link" },
      ok: false,
    });
  });

  test("each refused field gets its own message, keyed by the path it posts to, whichever locale broke it", () => {
    const draft = pageDraftOf(editor);
    const key = onlyGroupKey(draft.layout);
    const parsed = pageInputOf({
      ...draft,
      contactUrl: "ops@example.test",
      customCss: "a{}</style>",
      customDomain: "https://status.example.test",
      description: { ar: "وصف", en: "a".repeat(501) },
      footerLinks: [
        { key: "x", label: arabic("a".repeat(41)), url: "ftp://x.test" },
      ],
      labels: { ...draft.labels, major_outage: { ar: "", en: "a".repeat(41) } },
      layout: renameGroup(draft.layout, key, none),
      slug: "-bad-",
      title: none,
    });
    expect(parsed).toEqual({
      errors: {
        "customization.contactUrl": "page_refused_link",
        "customization.customCss": "page_refused_css",
        "customization.description": "page_refused_description",
        "customization.footerLinks.0.label": "page_refused_footer_label",
        "customization.footerLinks.0.url": "page_refused_link",
        "customization.labels.major_outage": "page_refused_label",
        customDomain: "page_refused_domain",
        [`layout.${key}`]: "page_refused_group",
        slug: "page_refused_slug",
        title: "page_refused_title",
      },
      ok: false,
    });
  });

  test("the new page's form posts its three fields, the slug in lower case", () => {
    expect(
      newPageInputOf({ locale: "en", slug: " Main ", title: " Status " })
    ).toEqual({
      input: { locale: "en", slug: "main", title: "Status" },
      ok: true,
    });
    expect(newPageInputOf({ locale: "ar", slug: "a_b", title: "" })).toEqual({
      errors: { slug: "page_refused_slug", title: "page_refused_title" },
      ok: false,
    });
  });
});

describe("arranging a page's components", () => {
  const layout = (): DraftItem[] => [...pageDraftOf(editor).layout];

  test("an added component goes to the end of the top level, once", () => {
    const added = addComponent(layout(), "new");
    expect(added.at(-1)).toEqual({ componentId: "new", kind: "component" });
    expect(addComponent(added, "api")).toEqual(added);
  });

  test("an added group is empty, at the end, under a key no other group has", () => {
    const once = addGroup(layout(), arabic("مجموعة جديدة"));
    const twice = addGroup(once, arabic("أخرى"));
    const keys = twice.flatMap((item) =>
      item.kind === "group" ? [item.key] : []
    );
    expect(new Set(keys).size).toBe(3);
    expect(twice.at(-1)).toMatchObject({
      componentIds: [],
      kind: "group",
      name: arabic("أخرى"),
    });
  });

  test("a group added after another was removed never takes a key still in use", () => {
    const two = addGroup(addGroup([], arabic("A")), arabic("B"));
    const firstKey = two[0]?.kind === "group" ? two[0].key : "";
    const again = addGroup(removeGroup(two, firstKey), arabic("C"));
    const keys = again.flatMap((item) =>
      item.kind === "group" ? [item.key] : []
    );
    expect(new Set(keys).size).toBe(2);
  });

  test("a component moved to a group that is not there stays where it was", () => {
    expect(moveComponentTo(layout(), "web", "no-such-group")).toEqual(layout());
  });

  test("a top-level entry moves among the top level, a group with its components", () => {
    const key = onlyGroupKey(layout());
    expect(
      placedComponents(moveEntry(layout(), { groupKey: key }, -1))
    ).toEqual(["api", "db", "web"]);
    expect(
      placedComponents(moveEntry(layout(), { componentId: "web" }, 1))
    ).toEqual(["api", "db", "web"]);
  });

  test("a grouped component moves inside its group only", () => {
    const moved = moveEntry(layout(), { componentId: "db" }, -1);
    expect(placedComponents(moved)).toEqual(["web", "db", "api"]);
    expect(groupOf(moved, "db")).toBe(onlyGroupKey(layout()));
  });

  test("an entry at an edge stays where it is", () => {
    expect(moveEntry(layout(), { componentId: "web" }, -1)).toEqual(layout());
    expect(moveEntry(layout(), { componentId: "db" }, 1)).toEqual(layout());
    expect(
      moveEntry(layout(), { groupKey: onlyGroupKey(layout()) }, 1)
    ).toEqual(layout());
  });

  test("a component moved to a group lands at its end; moved to the top level, at the end of that", () => {
    const key = onlyGroupKey(layout());
    const intoGroup = moveComponentTo(layout(), "web", key);
    expect(groupOf(intoGroup, "web")).toBe(key);
    expect(placedComponents(intoGroup)).toEqual(["api", "db", "web"]);
    const out = moveComponentTo(layout(), "api", undefined);
    expect(groupOf(out, "api")).toBeUndefined();
    expect(placedComponents(out)).toEqual(["web", "db", "api"]);
  });

  test("a removed component leaves the page from wherever it was", () => {
    expect(placedComponents(removeComponent(layout(), "web"))).toEqual([
      "api",
      "db",
    ]);
    expect(placedComponents(removeComponent(layout(), "api"))).toEqual([
      "web",
      "db",
    ]);
  });

  test("a removed group leaves its components at the top level, where it stood", () => {
    const removed = removeGroup(layout(), onlyGroupKey(layout()));
    expect(removed).toEqual([
      { componentId: "web", kind: "component" },
      { componentId: "api", kind: "component" },
      { componentId: "db", kind: "component" },
    ]);
  });

  test("a renamed group keeps its components and its key", () => {
    const key = onlyGroupKey(layout());
    const renamed = renameGroup(layout(), key, arabic("Core"));
    expect(renamed.find((item) => item.kind === "group")).toEqual({
      componentIds: ["api", "db"],
      key,
      kind: "group",
      name: arabic("Core"),
    });
  });
});
