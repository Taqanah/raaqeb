/**
 * The account page's cards of the operator's own: their name, which the
 * team page shows (empty lets the email stand for it), and their sessions,
 * each browser signed in to the account, with ending one or every other.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useState,
} from "react";
import { FormFooter } from "@/admin/shell/page.tsx";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { browserAgentOf } from "@/shared/domain/user-agent.ts";
import { formatDateTime, type TimeOptions } from "@/shared/i18n/format.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  NameChangeInput,
  SaveRefusal,
  SaveResult,
  SessionEndInput,
} from "@/shared/schemas/settings.ts";
import type { AccountSession } from "@/shared/schemas/team.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { type SaveCall, useDraftSave } from "./use-save.ts";

const saveMessages: Readonly<Record<SaveRefusal, MessageId>> = {
  invalid: "setting_invalid",
  unavailable: "setting_unavailable",
};

export interface NameFormProps {
  readonly name: string;
  readonly onSaved: () => void;
  readonly save: SaveCall<NameChangeInput, SaveRefusal>;
}

export function NameForm({ name, onSaved, save }: NameFormProps): ReactNode {
  const { t } = useMessages();
  const [typed, setTyped] = useState({ name });
  const onTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTyped({ name: event.currentTarget.value });
  }, []);
  const saving = useDraftSave(save, typed, { onSaved });
  const { submit } = saving;
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit({ name: typed.name.trim() });
    },
    [submit, typed]
  );
  return (
    <form data-slot="name-form" method="post" noValidate onSubmit={onSubmit}>
      <Card>
        <CardHeader divided>
          <CardTitle>{t("setting_name")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor="name">{t("setting_name_label")}</FieldLabel>
            <Input
              autoComplete="name"
              id="name"
              maxLength={100}
              name="name"
              onChange={onTyped}
              value={typed.name}
            />
            <FieldDescription>{t("setting_name_note")}</FieldDescription>
          </Field>
        </CardContent>
        <SaveFooter
          label={t("app_save")}
          refusals={saveMessages}
          view={saving}
        />
      </Card>
    </form>
  );
}

export interface SessionsCardProps {
  readonly clock: TimeOptions;
  readonly end: (input: SessionEndInput) => Promise<SaveResult>;
  readonly onEnded: () => void;
  /** Nothing when they could not be read. */
  readonly sessions: readonly AccountSession[] | undefined;
}

export function SessionsCard({
  clock,
  end,
  onEnded,
  sessions,
}: SessionsCardProps): ReactNode {
  const { locale, t } = useMessages();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = useCallback(
    (input: SessionEndInput) => {
      setPending(true);
      setFailed(false);
      end(input).then(
        (result) => {
          setPending(false);
          if (result.ok) {
            onEnded();
          } else {
            setFailed(true);
          }
        },
        () => {
          setPending(false);
          setFailed(true);
        }
      );
    },
    [end, onEnded]
  );
  const endOthers = useCallback(() => run({}), [run]);
  const others = sessions?.filter((one) => !one.current) ?? [];
  return (
    <Card data-slot="sessions">
      <CardHeader divided>
        <CardTitle>{t("setting_sessions")}</CardTitle>
        <CardDescription>{t("setting_sessions_note")}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions === undefined ? (
          <FieldError>{t("setting_unavailable")}</FieldError>
        ) : (
          <FieldGroup>
            {sessions.map((session) => (
              <SessionRow
                clock={clock}
                key={session.id}
                locale={locale}
                onEnd={run}
                pending={pending}
                session={session}
              />
            ))}
          </FieldGroup>
        )}
      </CardContent>
      <FormFooter
        outcome={
          failed ? <FieldError>{t("setting_unavailable")}</FieldError> : null
        }
      >
        <Button
          data-slot="end-other-sessions"
          disabled={pending || others.length === 0}
          onClick={endOthers}
          type="button"
          variant="destructive-outline"
        >
          {t("setting_sessions_end_others")}
        </Button>
      </FormFooter>
    </Card>
  );
}

function SessionRow({
  clock,
  locale,
  onEnd,
  pending,
  session,
}: {
  readonly clock: TimeOptions;
  readonly locale: Locale;
  readonly onEnd: (input: SessionEndInput) => void;
  readonly pending: boolean;
  readonly session: AccountSession;
}): ReactNode {
  const { t } = useMessages();
  const browser = session.userAgent
    ? browserAgentOf(session.userAgent)
    : undefined;
  const end = useCallback(() => onEnd({ id: session.id }), [onEnd, session]);
  return (
    <div
      className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
      data-current={session.current}
      data-session={session.id}
      data-slot="session"
    >
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {browser?.system
              ? t("setting_session_browser_on", {
                  browser: browser.browser,
                  system: browser.system,
                })
              : (browser?.browser ?? t("setting_session_browser_unknown"))}
          </span>
          {session.current ? (
            <Badge variant="secondary">{t("setting_session_current")}</Badge>
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          <dt>{t("setting_session_signed_in")}</dt>
          <dd>{formatDateTime(locale, session.createdAt, clock)}</dd>
          <dt>{t("setting_session_last")}</dt>
          <dd>{formatDateTime(locale, session.updatedAt, clock)}</dd>
          {session.ipAddress ? (
            <>
              <dt>{t("setting_session_address")}</dt>
              <dd>
                <Token>{session.ipAddress}</Token>
              </dd>
            </>
          ) : null}
        </dl>
      </div>
      {session.current ? null : (
        <Button
          className="shrink-0 self-start"
          data-slot="end-session"
          disabled={pending}
          onClick={end}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("setting_session_end")}
        </Button>
      )}
    </div>
  );
}
