import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronEndIcon,
  ChevronUpIcon,
  XIcon,
} from "./icons.tsx";

const icons = {
  CheckIcon,
  ChevronDownIcon,
  ChevronEndIcon,
  ChevronUpIcon,
  XIcon,
};

describe("the inline icons", () => {
  test.each(Object.entries(icons))(
    "%s is an inline SVG on a 24 unit box, stroked in the current colour and hidden from assistive technology",
    (_, Icon) => {
      const html = renderToStaticMarkup(<Icon />);
      expect(html).toStartWith("<svg ");
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('fill="none"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain("<path ");
    }
  );

  test("a caller's class and size reach the svg", () => {
    const html = renderToStaticMarkup(<XIcon className="size-3" />);
    expect(html).toContain('class="size-3"');
  });

  test("the chevron that points along the reading direction mirrors under RTL; the vertical ones and the marks never do", () => {
    expect(renderToStaticMarkup(<ChevronEndIcon />)).toContain(
      "rtl:-scale-x-100"
    );
    for (const Icon of [CheckIcon, XIcon, ChevronDownIcon, ChevronUpIcon]) {
      expect(renderToStaticMarkup(<Icon />)).not.toContain("rtl:");
    }
  });
});
