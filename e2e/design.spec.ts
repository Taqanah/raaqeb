import { expect, test } from "./support/fixtures.ts";

// The sample page is a development page: the built
// entry, which is what ships, must not serve it, and its code must not sit
// in the client assets the entry preloads into memory.
test("the design sample page is not part of the shipped app", async ({
  page,
}) => {
  const response = await page.request.get("/design");
  expect(response.status()).toBe(404);
});

test("the sample page's code is absent from the built client assets", async () => {
  const glob = new Bun.Glob("**/*.js");
  for await (const file of glob.scan({ cwd: "dist/client" })) {
    const text = await Bun.file(`dist/client/${file}`).text();
    // A string only the sample page carries: its locale links.
    expect(text, file).not.toContain("/design?locale=");
  }
});
