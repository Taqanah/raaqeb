/**
 * Status pages: the page as a visitor reads it during an incident,
 * its updates posted one after another as the section plays (investigating,
 * identified, monitoring, resolved) until the banner turns green, and the
 * ways a visitor follows it under the frame.
 */
import { type ReactNode, useEffect, useState } from "react";
import { MailIcon, RssIcon, WebhookIcon } from "@/shared/ui/icons.tsx";
import type { Copy } from "~/copy.ts";
import { BracesIcon } from "./icons.tsx";
import { Frame, Section, useSeen } from "./section.tsx";
import { StatusPage } from "./status-page.tsx";

/** The pause between two updates, in ms. */
const beat = 1700;

export function Pages({ copy }: { readonly copy: Copy }): ReactNode {
  const p = copy.pages;
  const total = copy.demo.updates.length;
  const [ref, seen] = useSeen();
  const [played, setPlayed] = useState(1);
  // Posts the updates in turn once the section is seen; reduced motion shows the incident resolved.
  useEffect(() => {
    if (!seen) {
      return;
    }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPlayed(total);
      return;
    }
    const timer = setInterval(() => {
      setPlayed((n) => {
        if (n + 1 >= total) {
          clearInterval(timer);
        }
        return Math.min(total, n + 1);
      });
    }, beat);
    return () => clearInterval(timer);
  }, [seen, total]);
  return (
    <Section id="pages" lead={p.lead} title={p.title}>
      <div ref={ref}>
        <Frame>
          <StatusPage lang={copy.locale} played={played} />
        </Frame>
      </div>
      <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3 text-strong">
        <span className="font-medium text-fg">{p.also}</span>
        <Way icon={<MailIcon className="text-muted" />} name={p.feeds[0]} />
        <Way icon={<WebhookIcon className="text-muted" />} name={p.feeds[1]} />
        <Way icon={<RssIcon className="text-partial" />} name={p.feeds[2]} />
        <Way
          icon={<BracesIcon className="text-teal-text" />}
          name={p.feeds[3]}
        />
      </div>
    </Section>
  );
}

/** A way a visitor follows the page, by its mark and name. */
function Way({
  icon,
  name,
}: {
  readonly icon: ReactNode;
  readonly name: string;
}): ReactNode {
  return (
    <span className="inline-flex items-center gap-2 font-medium [&>svg]:size-5">
      {icon}
      {name}
    </span>
  );
}
