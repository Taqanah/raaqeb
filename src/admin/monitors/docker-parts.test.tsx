import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { noCredentials } from "@/shared/schemas/credentials.ts";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { DockerTarget } from "./docker-parts.tsx";
import { draftOf } from "./draft.ts";

const noop = () => undefined;
const listNothing = () => Promise.resolve(undefined);

function arabic(): string {
  return renderToString(
    <MessagesProvider i18n={createMessages("ar", ar)}>
      <DockerTarget
        draft={{ ...draftOf(undefined, noCredentials), type: "docker" }}
        errors={{
          "config.container": { id: "monitor_error_container" },
          "config.endpoint": { id: "monitor_error_docker_endpoint" },
        }}
        listContainers={listNothing}
        onChoice={noop}
        onField={noop}
      />
    </MessagesProvider>
  );
}

describe("a Docker monitor's fields in Arabic", () => {
  test("isolate a path and the characters a name may hold left to right, so none reads backwards", () => {
    const html = arabic();
    expect(html).toContain("⁦/var/run/docker.sock⁩");
    expect(html).toContain("⁦/⁩");
    for (const sign of ["_", ".", "-"]) {
      expect(html).toContain(`⁦${sign}⁩`);
    }
  });
});
