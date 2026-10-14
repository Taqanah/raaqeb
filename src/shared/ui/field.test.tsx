import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, FieldDescription, FieldError, FieldLabel } from "./field.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

const describedBy = /aria-describedby="([^"]+)"/;
const idOf = (html: string, text: string) =>
  new RegExp(`id="([^"]+)"[^>]*>${text}<`).exec(html)?.[1];

describe("a field's description of its input", () => {
  test("an input is described by the field's hints and its refusal, in the order they show", () => {
    const html = renderToStaticMarkup(
      <Field>
        <FieldLabel htmlFor="slug">Slug</FieldLabel>
        <Input aria-invalid id="slug" readOnly value="" />
        <FieldDescription>Letters and digits.</FieldDescription>
        <FieldDescription>Served at /status/x</FieldDescription>
        <FieldError>Type a slug.</FieldError>
      </Field>
    );
    const ids = [
      idOf(html, "Letters and digits."),
      idOf(html, "Served at /status/x"),
      idOf(html, "Type a slug."),
    ];
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(describedBy.exec(html)?.[1]).toBe(ids.join(" "));
  });

  test("a textarea is described the same way", () => {
    const html = renderToStaticMarkup(
      <Field>
        <Textarea readOnly value="" />
        <FieldDescription>Optional.</FieldDescription>
      </Field>
    );
    const hint = idOf(html, "Optional.");
    expect(hint).toBeDefined();
    expect(describedBy.exec(html)?.[1]).toBe(hint);
  });

  test("a field with no hint and no refusal describes nothing", () => {
    const html = renderToStaticMarkup(
      <Field>
        <Input readOnly value="" />
      </Field>
    );
    expect(html).not.toContain("aria-describedby");
  });

  test("an input's own description is kept, and two fields never share an id", () => {
    const html = renderToStaticMarkup(
      <>
        <Field>
          <Input aria-describedby="own" readOnly value="" />
          <FieldDescription>First.</FieldDescription>
        </Field>
        <Field>
          <Input readOnly value="" />
          <FieldDescription>Second.</FieldDescription>
        </Field>
      </>
    );
    expect(html).toContain(`aria-describedby="own ${idOf(html, "First.")}"`);
    expect(idOf(html, "First.")).not.toBe(idOf(html, "Second."));
  });
});
