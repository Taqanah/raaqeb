import { describe, expect, test } from "bun:test";

const content = `${import.meta.dir}/../content/docs`;
const frontMatter = /^---\n([\s\S]*?)\n---\n/;

describe("a docs page's front matter", () => {
  test("is YAML with a title and a description, so the website builds", async () => {
    const pages = [...new Bun.Glob("**/*.mdx").scanSync(content)];
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      // biome-ignore lint/performance/noAwaitInLoops: one page at a time names the failing one
      const text = await Bun.file(`${content}/${page}`).text();
      const block = frontMatter.exec(text)?.[1];
      expect(block, page).toBeDefined();
      expect(() => Bun.YAML.parse(block ?? ""), page).not.toThrow();
      expect(Bun.YAML.parse(block ?? ""), page).toMatchObject({
        description: expect.any(String),
        title: expect.any(String),
      });
    }
  });
});
