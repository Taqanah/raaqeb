import { describe, expect, test } from "bun:test";
import {
  componentsOf,
  customDomainOf,
  defaultCustomization,
  isCustomCss,
  isVisitorLink,
  pageCreateSchema,
  pageCustomizationSchema,
  pageImageUploadOf,
  pageImageUrl,
  pageInputSchema,
  pageLayoutSchema,
  pageSlugSchema,
} from "./page.ts";

describe("a custom domain as a page stores it (custom domain matching)", () => {
  test("a domain is kept in lower case", () => {
    expect(customDomainOf("Status.Example.TEST")).toBe("status.example.test");
  });

  test("white space around it and one trailing dot are dropped", () => {
    expect(customDomainOf("  status.example.test.  ")).toBe(
      "status.example.test"
    );
  });

  test("an internationalized name is kept in its ASCII form, as a request's host arrives", () => {
    expect(customDomainOf("حالة.مثال.إختبار")).toBe(
      new URL("http://حالة.مثال.إختبار").hostname
    );
    expect(customDomainOf("حالة.مثال.إختبار")?.startsWith("xn--")).toBe(true);
  });

  test("a scheme, a path, a port, a query or a user is not a domain", () => {
    for (const text of [
      "https://status.example.test",
      "status.example.test/path",
      "status.example.test:8443",
      "status.example.test?x=1",
      "user@status.example.test",
      "status.example.test#top",
    ]) {
      expect(customDomainOf(text)).toBeUndefined();
    }
  });

  test("an address, a name without a dot and an empty text are not domains", () => {
    for (const text of ["192.0.2.1", "[2001:db8::1]", "localhost", "", " "]) {
      expect(customDomainOf(text)).toBeUndefined();
    }
  });

  test("a label past 63 characters or a name past 253 is not a domain", () => {
    expect(customDomainOf(`${"a".repeat(64)}.example.test`)).toBeUndefined();
    expect(customDomainOf(`${"a".repeat(63)}.example.test`)).toBe(
      `${"a".repeat(63)}.example.test`
    );
    const long = Array.from({ length: 5 }, () => "a".repeat(60)).join(".");
    expect(customDomainOf(long)).toBeUndefined();
  });

  test("a wildcard, or a label that starts or ends with a dash, is not a domain no request can name", () => {
    for (const text of [
      "*.example.com",
      "-bad-.com",
      "bad-.example.test",
      "status.-example.test",
      "sta_tus.example.test",
    ]) {
      expect(customDomainOf(text)).toBeUndefined();
    }
    expect(customDomainOf("my-status.example.test")).toBe(
      "my-status.example.test"
    );
  });

  test("a name with white space or an empty label inside is not a domain", () => {
    for (const text of [
      "status example.test",
      "status..example.test",
      ".example.test",
    ]) {
      expect(customDomainOf(text)).toBeUndefined();
    }
  });
});

describe("a page's slug", () => {
  test("lower-case letters, digits and dashes up to 63, typed in any case", () => {
    expect(pageSlugSchema.parse("status")).toBe("status");
    expect(pageSlugSchema.parse(" Main-2 ")).toBe("main-2");
    expect(pageSlugSchema.parse("a".repeat(63))).toBe("a".repeat(63));
  });

  test("a dash at either end, another character or more than 63 is refused", () => {
    for (const text of ["-a", "a-", "a_b", "حالة", "a".repeat(64), "", "a b"]) {
      expect(pageSlugSchema.safeParse(text).success).toBe(false);
    }
  });
});

describe("a link a visitor follows", () => {
  test("https, http and mailto are links", () => {
    expect(isVisitorLink("https://example.test/help")).toBe(true);
    expect(isVisitorLink("http://example.test")).toBe(true);
    expect(isVisitorLink("mailto:support@example.test")).toBe(true);
  });

  test("another scheme, a bare host or an empty mailto is not", () => {
    for (const text of [
      "javascript:alert(1)",
      "ftp://example.test",
      "example.test",
      "mailto:",
      "https://",
      "",
    ]) {
      expect(isVisitorLink(text)).toBe(false);
    }
  });
});

describe("custom CSS", () => {
  test("CSS up to 64 KB is kept", () => {
    expect(isCustomCss("body { color: red; }")).toBe(true);
    expect(isCustomCss("a".repeat(65_536))).toBe(true);
  });

  test("CSS past 64 KB in UTF-8 is refused, counting bytes, not characters", () => {
    expect(isCustomCss("a".repeat(65_537))).toBe(false);
    // Each Arabic letter is two bytes in UTF-8.
    expect(isCustomCss("ع".repeat(32_769))).toBe(false);
  });

  test("CSS that could close the style element it is written into is refused", () => {
    expect(isCustomCss("a{}</style><script>alert(1)</script>")).toBe(false);
    expect(isCustomCss("a{}</STYLE>")).toBe(false);
    expect(isCustomCss("a { content: '<' }")).toBe(true);
  });
});

describe("a page's customization", () => {
  test("a new page's customization is every default", () => {
    expect(defaultCustomization).toEqual({
      barDays: 90,
      bars: true,
      footerLinks: [],
      labels: {},
      noindex: false,
      percentages: true,
      poweredBy: true,
      statusColours: {},
      subscriptions: ["email", "webhook"],
      theme: "system",
    });
  });

  test("a stored value missing a key a later version added reads that key's default", () => {
    const stored = pageCustomizationSchema.parse({ noindex: true });
    expect(stored).toEqual({ ...defaultCustomization, noindex: true });
  });

  test("colours are six hex digits, kept in lower case", () => {
    const parsed = pageCustomizationSchema.parse({
      brandColour: "#0F766E",
      statusColours: { major_outage: "#B91C1C" },
    });
    expect(parsed.brandColour).toBe("#0f766e");
    expect(parsed.statusColours).toEqual({ major_outage: "#b91c1c" });
    for (const colour of ["red", "#fff", "#12345g", "0f766e"]) {
      expect(
        pageCustomizationSchema.safeParse({ brandColour: colour }).success
      ).toBe(false);
    }
  });

  test("a label renames a status level for display, up to 40 characters, for the five levels only", () => {
    expect(
      pageCustomizationSchema.parse({
        labels: { operational: { ar: " كل شيء يعمل " } },
      }).labels
    ).toEqual({ operational: { ar: "كل شيء يعمل" } });
    expect(
      pageCustomizationSchema.safeParse({
        labels: { operational: { ar: "a".repeat(41) } },
      }).success
    ).toBe(false);
    expect(
      pageCustomizationSchema.safeParse({ labels: { fine: { ar: "fine" } } })
        .success
    ).toBe(false);
  });

  test("the bar spans 30, 60 or 90 days", () => {
    for (const days of [30, 60, 90] as const) {
      expect(pageCustomizationSchema.parse({ barDays: days }).barDays).toBe(
        days
      );
    }
    expect(pageCustomizationSchema.safeParse({ barDays: 45 }).success).toBe(
      false
    );
  });

  test("up to ten footer links, each with a label and a visitor link", () => {
    const link = {
      label: { ar: "المساعدة" },
      url: "https://example.test/help",
    };
    expect(
      pageCustomizationSchema.parse({ footerLinks: [link] }).footerLinks
    ).toEqual([link]);
    expect(
      pageCustomizationSchema.safeParse({
        footerLinks: Array.from({ length: 11 }, () => link),
      }).success
    ).toBe(false);
    expect(
      pageCustomizationSchema.safeParse({
        footerLinks: [{ label: { ar: "x" }, url: "javascript:alert(1)" }],
      }).success
    ).toBe(false);
  });

  test("the contact link is a visitor link", () => {
    expect(
      pageCustomizationSchema.parse({ contactUrl: "mailto:ops@example.test" })
        .contactUrl
    ).toBe("mailto:ops@example.test");
    expect(
      pageCustomizationSchema.safeParse({ contactUrl: "ops@example.test" })
        .success
    ).toBe(false);
  });

  test("the subscription channels shown are email and webhook, each once", () => {
    expect(
      pageCustomizationSchema.parse({ subscriptions: ["webhook", "webhook"] })
        .subscriptions
    ).toEqual(["webhook"]);
    expect(
      pageCustomizationSchema.parse({ subscriptions: [] }).subscriptions
    ).toEqual([]);
    expect(
      pageCustomizationSchema.safeParse({ subscriptions: ["slack"] }).success
    ).toBe(false);
  });

  test("custom CSS that could close its style element is refused", () => {
    expect(
      pageCustomizationSchema.safeParse({ customCss: "</style>" }).success
    ).toBe(false);
  });
});

describe("a page's ordered component list", () => {
  test("the components a layout shows are listed in its order, groups included", () => {
    expect(
      componentsOf([
        { componentId: "a", kind: "component" },
        { componentIds: ["b", "c"], kind: "group", name: { ar: "API" } },
        { componentId: "d", kind: "component" },
      ])
    ).toEqual(["a", "b", "c", "d"]);
  });

  test("a component appears at most once on a page", () => {
    expect(
      pageLayoutSchema.safeParse([
        { componentId: "a", kind: "component" },
        { componentIds: ["a"], kind: "group", name: { ar: "API" } },
      ]).success
    ).toBe(false);
  });

  test("a group needs a name, and may be empty", () => {
    expect(
      pageLayoutSchema.safeParse([
        { componentIds: [], kind: "group", name: { ar: " " } },
      ]).success
    ).toBe(false);
    expect(
      pageLayoutSchema.safeParse([
        { componentIds: [], kind: "group", name: { ar: "Later" } },
      ]).success
    ).toBe(true);
  });
});

describe("what the page forms post", () => {
  const input = {
    customization: defaultCustomization,
    isDefault: false,
    layout: [],
    locale: "ar",
    published: false,
    slug: "status",
    title: { ar: "حالة الخدمات" },
  };

  test("a custom domain is posted as the page stores it", () => {
    expect(
      pageInputSchema.parse({ ...input, customDomain: "Status.Example.TEST." })
        .customDomain
    ).toBe("status.example.test");
    expect(
      pageInputSchema.safeParse({ ...input, customDomain: "https://x.test" })
        .success
    ).toBe(false);
  });

  test("a page's title, description, footer link labels and group names need the page language's text; the other locale's is optional", () => {
    const english = {
      ...input,
      customization: {
        ...defaultCustomization,
        description: { ar: "حالتنا", en: "Our status" },
        footerLinks: [
          { label: { en: "Help" }, url: "https://example.test/help" },
        ],
      },
      layout: [{ componentIds: [], kind: "group", name: { en: "Core" } }],
      locale: "en",
      title: { en: "Status" },
    };
    expect(pageInputSchema.safeParse(english).success).toBe(true);
    const refused = pageInputSchema.safeParse({ ...english, locale: "ar" });
    expect(
      refused.error?.issues.map((issue) => issue.path.join(".")).toSorted()
    ).toEqual(["customization.footerLinks.0.label", "layout.0.name", "title"]);
    expect(
      pageInputSchema.safeParse({
        ...english,
        customization: {
          ...english.customization,
          description: { ar: "حالتنا" },
        },
      }).error?.issues[0]?.path
    ).toEqual(["customization", "description"]);
  });

  test("a status name may be written in either locale alone, since a locale without one shows the catalog's", () => {
    expect(
      pageInputSchema.safeParse({
        ...input,
        customization: {
          ...defaultCustomization,
          labels: { operational: { en: "All good" } },
        },
      }).success
    ).toBe(true);
  });

  test("a title is up to 100 characters and the language is a locale", () => {
    expect(
      pageCreateSchema.safeParse({ locale: "ar", slug: "s", title: "" }).success
    ).toBe(false);
    expect(
      pageCreateSchema.safeParse({ locale: "fr", slug: "s", title: "t" })
        .success
    ).toBe(false);
    expect(
      pageCreateSchema.safeParse({
        locale: "en",
        slug: "s",
        title: "a".repeat(101),
      }).success
    ).toBe(false);
  });
});

describe("where a page image is served", () => {
  test("the URL names the page and the kind and carries the image's hash", () => {
    expect(
      pageImageUrl("0192-a", {
        contentType: "image/png",
        hash: "ab12",
        kind: "logo",
      })
    ).toBe("/api/pages/0192-a/logo?v=ab12");
  });
});

describe("an image upload's form data", () => {
  function form(entries: Record<string, string | Blob>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(entries)) {
      data.set(name, value);
    }
    return data;
  }

  test("the page's id, the kind and the file are read", () => {
    const file = new Blob([new Uint8Array([1])]);
    const upload = pageImageUploadOf(form({ file, id: "p1", kind: "favicon" }));
    expect(upload.id).toBe("p1");
    expect(upload.kind).toBe("favicon");
    expect(upload.file.size).toBe(1);
  });

  test("anything but form data, a missing id or file, or an unknown kind is refused", () => {
    const file = new Blob([new Uint8Array([1])]);
    for (const data of [
      { file, id: "p1", kind: "logo" },
      form({ id: "p1", kind: "logo" }),
      form({ file, kind: "logo" }),
      form({ file, id: "", kind: "logo" }),
      form({ file, id: "p1", kind: "banner" }),
      form({ file: "text", id: "p1", kind: "logo" }),
    ]) {
      expect(() => pageImageUploadOf(data)).toThrow();
    }
  });
});

describe("custom domain matching, harder cases", () => {
  test("an ASCII form typed as such is kept as it is", () => {
    const ascii = new URL("http://حالة.مثال.إختبار").hostname;
    expect(customDomainOf(ascii)).toBe(ascii);
    expect(customDomainOf(ascii.toUpperCase())).toBe(ascii);
  });

  test("two trailing dots, or a name of digits written as an address, are not domains", () => {
    expect(customDomainOf("status.example.test..")).toBeUndefined();
    expect(customDomainOf("0x7f.1")).toBeUndefined();
    expect(customDomainOf("1.2")).toBeUndefined();
  });
});
