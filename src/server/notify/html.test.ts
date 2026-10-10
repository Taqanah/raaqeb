import { describe, expect, test } from "bun:test";
import { htmlLinks, htmlText } from "./fixture.ts";
import { type MailContent, mailHtml } from "./html.ts";

interface Found {
  readonly attributes: Readonly<Record<string, string>>;
  readonly tag: string;
}

/** Every element of the document with its attributes, as a client's parser reads them. */
async function elementsOf(html: string): Promise<Found[]> {
  const found: Found[] = [];
  // biome-ignore lint/correctness/noUndeclaredVariables: Bun's global, which Biome does not list
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        found.push({
          attributes: Object.fromEntries(element.attributes),
          tag: element.tagName,
        });
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

const target = "https://api.example.test/v1/health";

const arabic: MailContent = {
  buttons: [
    {
      url: "https://status.example.test/admin/monitors/0199",
      words: "فتح المراقبة",
    },
    {
      url: "https://status.example.test/admin/incidents/new?monitor=0199",
      words: "فتح حادثة",
    },
  ],
  footer: {
    link: {
      url: "https://status.example.test/subscriptions/tok",
      words: "إلغاء الاشتراك",
    },
    text: "وصلتك هذه الرسالة لأنك مشترك في تحديثات حالة المتجر.",
  },
  heading: "واجهة الدفع",
  lines: [
    { text: `الهدف: ${target}`, token: target },
    { text: "العلة: انتهت مهلة الانتظار" },
  ],
  locale: "ar",
  sentence: "المراقبة متعطّلة.",
  subject: "واجهة الدفع: متعطّل",
  update: "نتحرّى فشل الدفع منذ 9:40 ص.\n\nApple Pay works again.",
};

const english: MailContent = {
  ...arabic,
  heading: "Payments API",
  lines: [{ text: `Target: ${target}`, token: target }],
  locale: "en",
  sentence: "The monitor is down.",
};

/** The text cells: the ones that set a typeface. */
const textCells = (found: Found[]) =>
  found.filter(
    (each) =>
      each.tag === "td" && (each.attributes.style ?? "").includes("font-family")
  );

describe("an email's HTML part", () => {
  test("an Arabic email reads right to left on its root, its body, every table and every text cell", async () => {
    const found = await elementsOf(mailHtml(arabic));
    expect(found.find((each) => each.tag === "html")?.attributes).toMatchObject(
      { dir: "rtl", lang: "ar" }
    );
    expect(found.find((each) => each.tag === "body")?.attributes.dir).toBe(
      "rtl"
    );
    const tables = found.filter((each) => each.tag === "table");
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.attributes.dir).toBe("rtl");
    }
    const cells = textCells(found);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.attributes.dir).toBe("rtl");
      expect(cell.attributes.align).toBe("right");
      expect(cell.attributes.style).toContain("text-align:right");
    }
  });

  test("an English email reads left to right the same way", async () => {
    const found = await elementsOf(mailHtml(english));
    expect(found.find((each) => each.tag === "html")?.attributes).toMatchObject(
      { dir: "ltr", lang: "en" }
    );
    expect(found.find((each) => each.tag === "body")?.attributes.dir).toBe(
      "ltr"
    );
    const tables = found.filter((each) => each.tag === "table");
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.attributes.dir).toBe("ltr");
    }
    const cells = textCells(found);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.attributes.dir).toBe("ltr");
      expect(cell.attributes.align).toBe("left");
      expect(cell.attributes.style).toContain("text-align:left");
    }
  });

  test("shows the heading, the sentence, the update and each line as written, in that order, with no name above the card", () => {
    const shown = htmlText(mailHtml(arabic)).split("\n");
    expect(shown).not.toContain("راقب");
    const order = [
      "واجهة الدفع",
      "المراقبة متعطّلة.",
      "نتحرّى فشل الدفع منذ 9:40 ص.",
      "Apple Pay works again.",
      `الهدف: ${target}`,
      "العلة: انتهت مهلة الانتظار",
    ].map((each) => shown.lastIndexOf(each));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  test("a line's machine value stays left to right in a monospace isolate", async () => {
    const html = mailHtml(arabic);
    const isolates = (await elementsOf(html)).filter(
      (each) => each.tag === "span" && each.attributes.dir === "ltr"
    );
    expect(isolates).toHaveLength(1);
    expect(isolates[0]?.attributes.style).toContain("unicode-bidi:isolate");
    expect(isolates[0]?.attributes.style).toContain("monospace");
    expect(htmlText(html).split("\n")).toContain(`الهدف: ${target}`);
  });

  test("a URL in a line may break after a slash and nowhere inside a word", () => {
    const html = mailHtml(arabic);
    expect(html).toContain(
      "https://<wbr>api.example.test/<wbr>v1/<wbr>health</span>"
    );
    expect(html).not.toContain("break-all");
    expect(html).not.toContain("overflow-wrap:anywhere");
  });

  test("each link is a button that shows its words, the footer's words open its link, and no address shows as text", () => {
    const html = mailHtml(arabic);
    expect(htmlLinks(html)).toEqual([
      ...arabic.buttons,
      {
        url: "https://status.example.test/subscriptions/tok",
        words: "إلغاء الاشتراك",
      },
    ]);
    const shown = htmlText(html);
    expect(shown).not.toContain("https://status.example.test");
    expect(shown).toContain(
      "وصلتك هذه الرسالة لأنك مشترك في تحديثات حالة المتجر. إلغاء الاشتراك"
    );
  });

  test("a line whose machine value is not in it is written whole, with no isolate", async () => {
    const html = mailHtml({
      ...arabic,
      lines: [{ text: "العلة: انتهت مهلة الانتظار", token: target }],
    });
    expect(
      (await elementsOf(html)).filter((each) => each.tag === "span")
    ).toEqual([]);
    expect(htmlText(html).split("\n")).toContain("العلة: انتهت مهلة الانتظار");
  });

  test("a single break inside an update's paragraph stays a break", () => {
    const html = mailHtml({ ...arabic, update: "السطر الأول\nالسطر الثاني" });
    expect(html).toContain("السطر الأول<br>السطر الثاني</p>");
  });

  test("an update keeps each paragraph in the direction of its first letter", async () => {
    const paragraphs = (await elementsOf(mailHtml(arabic))).filter(
      (each) => each.tag === "p"
    );
    expect(paragraphs).toHaveLength(2);
    for (const paragraph of paragraphs) {
      expect(paragraph.attributes.dir).toBe("auto");
    }
  });

  test("the sentence is the first text, so an inbox shows it beside the subject", () => {
    expect(htmlText(mailHtml(arabic)).split("\n")[0]).toBe("المراقبة متعطّلة.");
  });

  test("an email with no heading, update, buttons or footer draws none of them", async () => {
    const bare: MailContent = {
      buttons: [],
      lines: [{ text: "123456", token: "123456" }],
      locale: "ar",
      sentence: "هذا رمزك المؤقت لتسجيل الدخول.",
      subject: "راقب: رمزك المؤقت",
    };
    const html = mailHtml(bare);
    const found = await elementsOf(html);
    expect(found.filter((each) => each.tag === "a")).toEqual([]);
    expect(found.filter((each) => each.tag === "p")).toEqual([]);
    expect(htmlText(html).split("\n")).toEqual([
      "هذا رمزك المؤقت لتسجيل الدخول.",
      "هذا رمزك المؤقت لتسجيل الدخول.",
      "123456",
    ]);
  });

  test("every value is escaped, so markup in a name shows as its text and opens no element and no attribute", async () => {
    const hostile = `<b onclick="alert(1)">&'`;
    const html = mailHtml({
      ...arabic,
      buttons: [{ url: `https://e.test/?a=1&b="x"`, words: hostile }],
      footer: {
        link: { url: "https://e.test/s", words: hostile },
        text: hostile,
      },
      heading: hostile,
      lines: [{ text: `${hostile} ${hostile}`, token: hostile }],
      sentence: hostile,
      subject: hostile,
      update: hostile,
    });
    const found = await elementsOf(html);
    expect(found.filter((each) => each.tag === "b")).toEqual([]);
    expect(
      found.filter((each) => Object.hasOwn(each.attributes, "onclick"))
    ).toEqual([]);
    expect(htmlText(html)).toContain(hostile);
    expect(htmlLinks(html)[0]).toEqual({
      url: `https://e.test/?a=1&b="x"`,
      words: hostile,
    });
    expect(html).toContain(
      `<title>${"&lt;b onclick=&quot;alert(1)&quot;&gt;&amp;&#x27;"}</title>`
    );
  });

  test("every style attribute is whole, so no font name ends it early", async () => {
    const styles = (await elementsOf(mailHtml(arabic)))
      .map((each) => each.attributes.style)
      .filter((each) => each !== undefined);
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) {
      expect(style.trimEnd()).toEndWith(";");
    }
  });

  test("declares light and dark colours, so a client in dark mode draws the dark ones", async () => {
    const html = mailHtml(arabic);
    const meta = (await elementsOf(html)).find(
      (each) => each.tag === "meta" && each.attributes.name === "color-scheme"
    );
    expect(meta?.attributes.content).toBe("light dark");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });
});
