import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { noCredentials } from "@/shared/schemas/credentials.ts";
import type { DatabaseCheckType } from "@/shared/schemas/monitor.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { draftOf } from "./draft.ts";
import { DatabaseTarget } from "./form.tsx";

const noop = () => undefined;
const i18n = createMessages("en", en);
// As the rendered HTML writes it, an apostrophe as `&#x27;`.
const askForTls = i18n
  ._("monitor_field_connection_url_mysql_hint")
  .replaceAll("'", "&#x27;");

function target(type: DatabaseCheckType): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <DatabaseTarget
        draft={{ ...draftOf(undefined, noCredentials), type }}
        errors={{}}
        onField={noop}
      />
    </MessagesProvider>
  );
}

describe("a database monitor's connection URL", () => {
  test("for MySQL suggests ?sslmode=require, since Raaqeb signs in to MySQL 8 only over an encrypted connection", () => {
    expect(target("mysql")).toContain(askForTls);
  });

  test("for Postgres or Redis says nothing of MySQL", () => {
    expect(target("postgres")).not.toContain(askForTls);
    expect(target("redis")).not.toContain(askForTls);
  });
});
