/**
 * The setup check page (CONTEXT.md "Setup check"): every check the
 * server could answer, passing or not, each saying what it found and, when it
 * fails, how to fix it. Read-only; tokens sit on lines of their own.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formWidth } from "@/admin/shell/page.tsx";
import {
  Bar,
  LoadingRegion,
  skeletonRows,
  TextBar,
} from "@/admin/shell/page-skeleton.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { SetupCheck } from "@/shared/schemas/setup-check.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { Token } from "@/shared/ui/token.tsx";

type T = (id: MessageId) => string;

interface Wording {
  /** How to fix it; only a failing check has one. */
  readonly fix?: ReactNode;
  /** What the check found. */
  readonly found: ReactNode;
  readonly title: string;
}

function Sentence({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function Tokens({ values }: { readonly values: readonly string[] }): ReactNode {
  return (
    <p className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Token key={value}>{value}</Token>
      ))}
    </p>
  );
}

function PageLink({
  label,
  to,
}: {
  readonly label: string;
  readonly to: string;
}): ReactNode {
  return (
    <Link className="w-fit text-sm underline underline-offset-4" to={to}>
      {label}
    </Link>
  );
}

/** A mode as the operator types it for chmod: `0755`. */
function modeText(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

const secretWords: Readonly<Record<string, MessageId>> = {
  "config.json": "setting_setup_secret_config",
  "raaqeb.sqlite": "setting_setup_secret_sqlite",
};

function forwardedWording(
  check: Extract<SetupCheck, { check: "forwarded" }>,
  t: T
): Wording {
  const title = t("setting_setup_forwarded");
  if (check.passed) {
    return {
      found: (
        <>
          <Sentence>
            {t(
              check.trusted
                ? "setting_setup_forwarded_trusted"
                : "setting_setup_forwarded_direct"
            )}
          </Sentence>
          <Tokens values={[check.peer]} />
        </>
      ),
      title,
    };
  }
  return {
    fix:
      check.proxiesFrom === "setting" ? (
        <>
          <Sentence>{t("setting_setup_forwarded_fix_setting")}</Sentence>
          <PageLink label={t("setting_trusted_proxies")} to="/admin/settings" />
        </>
      ) : (
        <>
          <Sentence>{t("setting_setup_forwarded_fix_boot")}</Sentence>
          <Tokens
            values={[
              check.proxiesFrom === "flag"
                ? "--trusted-proxies"
                : "RAAQEB_TRUSTED_PROXIES",
            ]}
          />
        </>
      ),
    found: (
      <>
        <Sentence>{t("setting_setup_forwarded_untrusted")}</Sentence>
        <Tokens values={[check.peer]} />
        <Sentence>{t("setting_setup_forwarded_headers")}</Sentence>
        <Tokens values={check.headers} />
      </>
    ),
    title,
  };
}

function addressWording(
  check: Extract<SetupCheck, { check: "public_address" }>,
  t: T
): Wording {
  const title = t("setting_public_address");
  if (check.passed) {
    return {
      found: (
        <>
          <Sentence>{t("setting_setup_address_match")}</Sentence>
          <Tokens values={[check.browser]} />
        </>
      ),
      title,
    };
  }
  return {
    fix: (
      <>
        <Sentence>{t("setting_setup_address_fix")}</Sentence>
        <PageLink label={t("setting_public_address")} to="/admin/settings" />
      </>
    ),
    found:
      check.stored === undefined ? (
        <Sentence>{t("setting_setup_address_missing")}</Sentence>
      ) : (
        <>
          <Sentence>{t("setting_setup_address_mismatch")}</Sentence>
          <Sentence>{t("setting_setup_address_stored")}</Sentence>
          <Tokens values={[check.stored]} />
          <Sentence>{t("setting_setup_address_browser")}</Sentence>
          <Tokens values={[check.browser]} />
        </>
      ),
    title,
  };
}

function emailWording(passed: boolean, t: T): Wording {
  const title = t("setting_setup_email");
  if (passed) {
    return {
      found: <Sentence>{t("setting_setup_email_present")}</Sentence>,
      title,
    };
  }
  return {
    fix: (
      <>
        <Sentence>{t("setting_setup_email_fix")}</Sentence>
        <PageLink label={t("channel_list_title")} to="/admin/channels" />
      </>
    ),
    found: <Sentence>{t("setting_setup_email_missing")}</Sentence>,
    title,
  };
}

function modeWording(
  check: Extract<SetupCheck, { check: "data_directory_mode" }>,
  t: T
): Wording {
  const title = t("setting_setup_mode");
  const where = <Tokens values={[check.path, modeText(check.mode)]} />;
  if (check.mode % 0o100 === 0) {
    return {
      found: (
        <>
          <Sentence>{t("setting_setup_mode_private")}</Sentence>
          {where}
        </>
      ),
      title,
    };
  }
  if (check.passed) {
    return {
      found: (
        <>
          <Sentence>{t("setting_setup_mode_open_empty")}</Sentence>
          {where}
        </>
      ),
      title,
    };
  }
  return {
    fix: (
      <>
        {/* chmod on the server does not reach a volume, and the image has no shell to run it in. */}
        {check.onHostRoot ? (
          <>
            <Sentence>{t("setting_setup_mode_fix")}</Sentence>
            <Tokens values={[`chmod 700 ${check.path}`]} />
          </>
        ) : (
          <Sentence>{t("setting_setup_mode_fix_volume")}</Sentence>
        )}
      </>
    ),
    found: (
      <>
        <Sentence>{t("setting_setup_mode_open_secret")}</Sentence>
        {where}
        <ul className="flex flex-col gap-1.5">
          {check.secrets.map((name) => {
            const words = secretWords[name];
            return (
              <li className="text-muted-foreground text-sm" key={name}>
                <Token>{name}</Token>
                {words ? <p className="mt-1">{t(words)}</p> : null}
              </li>
            );
          })}
        </ul>
      </>
    ),
    title,
  };
}

function volumeWording(
  check: Extract<SetupCheck, { check: "data_directory_volume" }>,
  t: T
): Wording {
  const title = t("setting_setup_volume");
  const where = <Tokens values={[check.path]} />;
  if (check.passed) {
    return {
      found: (
        <>
          <Sentence>{t("setting_setup_volume_kept")}</Sentence>
          {where}
        </>
      ),
      title,
    };
  }
  if (check.mount === "memory") {
    return {
      fix: (
        <>
          <Sentence>{t("setting_setup_volume_memory_fix")}</Sentence>
          {where}
        </>
      ),
      found: <Sentence>{t("setting_setup_volume_memory")}</Sentence>,
      title,
    };
  }
  if (check.mount === "anonymous_volume") {
    return {
      fix: (
        <>
          <Sentence>{t("setting_setup_volume_anonymous_fix")}</Sentence>
          <Tokens values={[`-v raaqeb-data:${check.path}`]} />
        </>
      ),
      found: <Sentence>{t("setting_setup_volume_anonymous")}</Sentence>,
      title,
    };
  }
  return {
    fix: (
      <>
        <Sentence>{t("setting_setup_volume_fix")}</Sentence>
        {where}
      </>
    ),
    found: <Sentence>{t("setting_setup_volume_lost")}</Sentence>,
    title,
  };
}

function wordingOf(check: SetupCheck, t: T): Wording {
  switch (check.check) {
    case "forwarded":
      return forwardedWording(check, t);
    case "public_address":
      return addressWording(check, t);
    case "email_channel":
      return emailWording(check.passed, t);
    case "data_directory_mode":
      return modeWording(check, t);
    case "data_directory_volume":
      return volumeWording(check, t);
    default:
      return check satisfies never;
  }
}

export function SetupCheckList({
  checks,
}: {
  readonly checks: readonly SetupCheck[];
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card className={formWidth} data-slot="setup-check">
      <CardHeader>
        <CardTitle>{t("setting_setup_check")}</CardTitle>
        <CardDescription>{t("setting_setup_intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {checks.map((check) => {
            const { fix, found, title } = wordingOf(check, t);
            return (
              <li
                className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0"
                data-check={check.check}
                data-passed={check.passed}
                key={check.check}
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-medium text-sm">{title}</h3>
                  {/* The badge's own mark tells passed from failed, so no second icon. */}
                  <Badge variant={check.passed ? "up" : "down"}>
                    {t(
                      check.passed
                        ? "setting_setup_passed"
                        : "setting_setup_failed"
                    )}
                  </Badge>
                </div>
                {found}
                {fix ? (
                  <div className="flex flex-col gap-2 border-s-2 ps-3">
                    {fix}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * The setup check page's placeholder in its shape: the card's
 * undivided header, then four checks, as many as a server can usually
 * judge, each a title with its badge over what it found. The page renders
 * in the browser alone, so this is also what the server sends for a
 * direct load.
 */
export function SetupCheckSkeleton(): ReactNode {
  return (
    <LoadingRegion className={cn("flex flex-col gap-6", formWidth)}>
      <Card>
        <CardHeader>
          <CardTitle>
            <TextBar className="w-32" />
          </CardTitle>
          <CardDescription>
            <TextBar className="w-full" />
            <TextBar className="w-48" />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {skeletonRows.slice(0, 4).map((row) => (
              <li
                className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0"
                key={row}
              >
                <div className="flex items-center justify-between gap-3">
                  <TextBar className="w-40" />
                  <Bar className="h-5 w-16" />
                </div>
                <TextBar className="w-72 text-sm" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </LoadingRegion>
  );
}
