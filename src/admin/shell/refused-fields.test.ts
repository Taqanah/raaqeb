import { describe, expect, test } from "bun:test";
import { type Refused, refusalsNow } from "./refused-fields.ts";

interface Draft {
  readonly slug: string;
  readonly title: string;
}

/** The form's rules: a title and a slug are each needed. */
const judge = (draft: Draft) => ({
  ...(draft.title === "" ? { title: "type a title" } : {}),
  ...(draft.slug === "" ? { slug: "type a slug" } : {}),
});

const empty: Draft = { slug: "", title: "" };

type Errors = ReturnType<typeof judge>;

describe("a form's field refusals", () => {
  test("none show before a save is refused, however the draft breaks the rules", () => {
    expect(refusalsNow(undefined, empty, judge)).toEqual({});
  });

  test("the refused draft shows the refusals it got, the server's too", () => {
    const refused: Refused<Draft, Errors> = {
      draft: empty,
      errors: { slug: "taken" },
    };
    expect(refusalsNow(refused, empty, judge)).toEqual({ slug: "taken" });
  });

  test("once the draft changes, a fixed field's refusal goes and the rest are judged again", () => {
    const refused: Refused<Draft, Errors> = {
      draft: empty,
      errors: judge(empty),
    };
    expect(refusalsNow(refused, { ...empty, title: "Status" }, judge)).toEqual({
      slug: "type a slug",
    });
    expect(
      refusalsNow(refused, { slug: "status", title: "Status" }, judge)
    ).toEqual({});
  });
});
