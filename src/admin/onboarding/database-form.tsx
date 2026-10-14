/**
 * The database screen: SQLite on this server by default, or a
 * Postgres URL tested before anything is written. The verdict is worded from
 * its code; on a verdict that can continue, the DATABASE_URL line for the
 * compose file is shown. Continue is the confirmation.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useState,
} from "react";
import { AuthPage } from "@/admin/auth/auth-page.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type DatabaseChoice,
  type DatabaseRefusal,
  databaseChoiceSchema,
} from "@/shared/schemas/onboarding.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { DatabaseIcon, FileIcon } from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  OptionCard,
  OptionCardBody,
  OptionCards,
} from "@/shared/ui/option-card.tsx";
import { Token } from "@/shared/ui/token.tsx";

/** What the connection test answers, as the screen sees it: the verdict kinds of the storage module. */
export type Verdict =
  | { kind: "empty" }
  | { kind: "raaqeb"; version: number }
  | { kind: "newer"; version: number }
  | { kind: "foreign-record" }
  | { kind: "foreign"; tables: number }
  | { kind: "unrecorded" }
  | { kind: "unreachable"; failure: string };

export type ChooseResult =
  | { readonly ok: true; readonly next: "account" | "done" }
  | { readonly ok: false; readonly reason: DatabaseRefusal };

export type TestResult =
  | { readonly ok: true; readonly verdict: Verdict }
  | { readonly ok: false; readonly reason: "already_chosen" };

export interface DatabaseFormProps {
  readonly choose: (choice: DatabaseChoice) => Promise<ChooseResult>;
  readonly onChosen: (next: "account" | "done") => void;
  /** How many screens this install's onboarding has; the database screen is the second. */
  readonly steps: number;
  readonly test: (url: string) => Promise<TestResult>;
}

type Failure = DatabaseRefusal | "unavailable";

const verdictMessage: Readonly<Record<Verdict["kind"], MessageId>> = {
  empty: "onboarding_verdict_empty",
  foreign: "onboarding_verdict_foreign",
  "foreign-record": "onboarding_verdict_foreign_record",
  newer: "onboarding_verdict_newer",
  raaqeb: "onboarding_verdict_raaqeb",
  unreachable: "onboarding_unreachable_unknown",
  unrecorded: "onboarding_verdict_unrecorded",
};

const unreachableMessage: Readonly<Record<string, MessageId>> = {
  authentication: "onboarding_unreachable_authentication",
  database: "onboarding_unreachable_database",
  malformed: "onboarding_unreachable_malformed",
  refused: "onboarding_unreachable_refused",
  timeout: "onboarding_unreachable_timeout",
  tls: "onboarding_unreachable_tls",
  unresolved: "onboarding_unreachable_unresolved",
  unknown: "onboarding_unreachable_unknown",
};

const refusalMessage: Readonly<Record<Failure, MessageId>> = {
  already_chosen: "onboarding_choose_already_chosen",
  invalid: "onboarding_choose_invalid",
  open_failed: "onboarding_choose_open_failed",
  refused: "onboarding_choose_refused",
  unavailable: "onboarding_unavailable",
};

/** The verdicts the continue button may act on; the server refuses the rest too. */
const continuable: ReadonlySet<Verdict["kind"]> = new Set([
  "empty",
  "raaqeb",
  "foreign",
]);

function messageFor(verdict: Verdict): MessageId {
  return verdict.kind === "unreachable"
    ? (unreachableMessage[verdict.failure] ?? "onboarding_unreachable_unknown")
    : verdictMessage[verdict.kind];
}

export function DatabaseForm({
  choose,
  onChosen,
  steps,
  test,
}: DatabaseFormProps): ReactNode {
  const { t } = useMessages();
  const [backend, setBackend] = useState<DatabaseChoice["backend"]>("sqlite");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | undefined>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();

  const changeBackend = useCallback((value: unknown) => {
    setBackend(value === "postgres" ? "postgres" : "sqlite");
    setVerdict(undefined);
    setFailure(undefined);
  }, []);

  const changeUrl = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setUrl(event.currentTarget.value);
    setVerdict(undefined);
  }, []);

  const runTest = useCallback(() => {
    setVerdict(undefined);
    setFailure(undefined);
    setTesting(true);
    test(url.trim()).then(
      (answer) => {
        setTesting(false);
        if (answer.ok) {
          setVerdict(answer.verdict);
        } else {
          setFailure(answer.reason);
        }
      },
      () => {
        setTesting(false);
        setFailure("unavailable");
      }
    );
  }, [test, url]);

  const submit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = databaseChoiceSchema.safeParse(
        backend === "sqlite" ? { backend } : { backend, url }
      );
      if (!parsed.success) {
        setFailure("invalid");
        return;
      }
      setFailure(undefined);
      setPending(true);
      choose(parsed.data).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            onChosen(result.next);
          } else {
            setFailure(result.reason);
          }
        },
        () => {
          setPending(false);
          setFailure("unavailable");
        }
      );
    },
    [backend, choose, onChosen, url]
  );

  const postgres = backend === "postgres";
  const canContinue =
    !postgres || (verdict !== undefined && continuable.has(verdict.kind));
  return (
    <AuthPage
      step={{ current: 2, total: steps }}
      title={t("onboarding_database_title")}
    >
      <form method="post" onSubmit={submit}>
        <FieldGroup>
          <FieldDescription>{t("onboarding_database_lead")}</FieldDescription>
          {/* Each place a card with what it means, chosen once; stacked, as the onboarding panel is narrow. */}
          <OptionCards
            aria-label={t("onboarding_database_title")}
            data-name="backend"
            name="backend"
            onValueChange={changeBackend}
            value={backend}
          >
            <OptionCard className="gap-3 pe-8" value="sqlite">
              <OptionCardBody
                description={t("onboarding_database_sqlite_note")}
                icon={<FileIcon />}
                title={t("onboarding_database_sqlite")}
              />
            </OptionCard>
            <OptionCard className="gap-3 pe-8" value="postgres">
              <OptionCardBody
                description={t("onboarding_database_postgres_note")}
                icon={<DatabaseIcon />}
                title={t("onboarding_database_postgres")}
              />
            </OptionCard>
          </OptionCards>
          {postgres ? (
            <PostgresFields
              onChangeUrl={changeUrl}
              onTest={runTest}
              testing={testing}
              url={url}
              verdict={verdict}
            />
          ) : null}
          {failure ? (
            <FieldError>{t(refusalMessage[failure])}</FieldError>
          ) : null}
          <Button disabled={pending || !canContinue} type="submit">
            {t("onboarding_continue")}
          </Button>
        </FieldGroup>
      </form>
    </AuthPage>
  );
}

interface PostgresFieldsProps {
  readonly onChangeUrl: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onTest: () => void;
  readonly testing: boolean;
  readonly url: string;
  readonly verdict: Verdict | undefined;
}

/** The URL, the test button, the worded verdict and, when the verdict can continue, the DATABASE_URL line. */
function PostgresFields({
  onChangeUrl,
  onTest,
  testing,
  url,
  verdict,
}: PostgresFieldsProps): ReactNode {
  const { t } = useMessages();
  const ok = verdict !== undefined && continuable.has(verdict.kind);
  return (
    <>
      <Field>
        <FieldLabel htmlFor="url">{t("onboarding_database_url")}</FieldLabel>
        <Input
          autoComplete="off"
          id="url"
          name="url"
          onChange={onChangeUrl}
          placeholder="postgres://user:password@host:5432/raaqeb"
          required
          type="url"
          value={url}
          variant="token"
        />
        <FieldDescription>{t("onboarding_database_url_hint")}</FieldDescription>
      </Field>
      <Button
        disabled={testing || url.trim() === ""}
        name="test"
        onClick={onTest}
        type="button"
        variant="outline"
      >
        {testing
          ? t("onboarding_database_testing")
          : t("onboarding_database_test")}
      </Button>
      {verdict ? (
        <Alert
          data-failure={
            verdict.kind === "unreachable" ? verdict.failure : undefined
          }
          data-verdict={verdict.kind}
          variant={ok ? "default" : "destructive"}
        >
          <AlertDescription>
            {t(messageFor(verdict), {
              version: verdict.kind === "raaqeb" ? verdict.version : undefined,
            })}
          </AlertDescription>
        </Alert>
      ) : null}
      {ok ? (
        <Field>
          <FieldDescription>
            {t("onboarding_database_url_line")}
          </FieldDescription>
          <output className="block" name="databaseUrl">
            <Token className="block select-all break-all">
              {`DATABASE_URL=${url.trim()}`}
            </Token>
          </output>
        </Field>
      ) : null}
    </>
  );
}
