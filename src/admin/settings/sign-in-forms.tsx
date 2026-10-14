/**
 * The sign-in settings page: which email channel sends the reset
 * link and the one-time code, a test message through it to the operator's
 * address, and the second step's switch, which turns on with emailed codes
 * only once a test message went through the channel in force, so nobody
 * locks themselves out. Better Auth takes the current password for either
 * way of the switch. The authenticator app's card is authenticator-form.tsx.
 */
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useState,
} from "react";
import { SendFailureText } from "@/admin/channels/send-parts.tsx";
import { FormFooter } from "@/admin/shell/page.tsx";
import { lineOf } from "@/admin/shell/save-flow.ts";
import { SaveFooter, SaveLine } from "@/admin/shell/save-footer.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  AuthEmailChannelInput,
  AuthTestResult,
  SaveRefusal,
  SecondStepInput,
  SecondStepRefusal,
  SecondStepResult,
  SecondStepView,
} from "@/shared/schemas/settings.ts";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { type SaveCall, useDraftSave, useSave } from "./use-save.ts";

const channelMessages: Readonly<Record<SaveRefusal, MessageId>> = {
  invalid: "setting_invalid",
  unavailable: "setting_unavailable",
};

const switchMessages: Readonly<Record<SecondStepRefusal, MessageId>> = {
  invalid: "setting_invalid",
  not_tested: "setting_second_step_not_tested",
  unavailable: "setting_unavailable",
  wrong_password: "setting_password_wrong",
};

export interface AuthEmailFormProps {
  readonly choose: SaveCall<AuthEmailChannelInput, SaveRefusal>;
  readonly onChanged: () => void;
  readonly sendTest: (input: AuthEmailChannelInput) => Promise<AuthTestResult>;
  readonly view: SecondStepView;
}

type TestState =
  | { readonly kind: "idle" | "pending" | "sent" }
  | {
      readonly kind: "failed";
      readonly result: Extract<AuthTestResult, { ok: false }>;
    };

/** The email channel auth mail goes through, and its test message. */
export function AuthEmailForm({
  choose,
  onChanged,
  sendTest,
  view,
}: AuthEmailFormProps): ReactNode {
  const { t } = useMessages();
  // With none chosen yet the select shows the first channel, which Save stores as it stands.
  const [channelId, setChannelId] = useState(
    view.channel ?? view.channels[0]?.id ?? ""
  );
  const onChannel = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setChannelId(event.currentTarget.value);
  }, []);
  const saving = useDraftSave(choose, channelId, {
    onSaved: onChanged,
    start: view.channel ?? "",
  });
  const { fail, submit } = saving;
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (channelId === "") {
        fail("invalid");
        return;
      }
      submit({ channelId });
    },
    [channelId, fail, submit]
  );
  const runTest = useCallback(() => {
    setTest({ kind: "pending" });
    sendTest({ channelId }).then(
      (result) => {
        setTest(result.ok ? { kind: "sent" } : { kind: "failed", result });
        onChanged();
      },
      () =>
        setTest({
          kind: "failed",
          result: { ok: false, reason: "unavailable" },
        })
    );
  }, [channelId, onChanged, sendTest]);
  const header = (
    <CardHeader divided>
      <CardTitle>{t("setting_auth_email_title")}</CardTitle>
      <CardDescription>
        {t("setting_auth_email_intro")} <Token>{view.email}</Token>
      </CardDescription>
    </CardHeader>
  );
  if (view.channels.length === 0) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm" data-slot="no-email-channel">
            {t("setting_auth_email_none")}{" "}
            <Link className="underline underline-offset-4" to="/admin/channels">
              {t("channel_list_title")}
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }
  // The test sends through the channel picked, saved or not, so it stays beside the choice and Save closes the card.
  return (
    <form data-slot="auth-email-form" method="post" onSubmit={onSubmit}>
      <Card>
        {header}
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="channelId">
                {t("setting_auth_email_channel")}
              </FieldLabel>
              <NativeSelect
                className="w-full"
                id="channelId"
                name="channelId"
                onChange={onChannel}
                value={channelId}
              >
                {view.channels.map((channel) => (
                  <NativeSelectOption key={channel.id} value={channel.id}>
                    {channel.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                data-slot="auth-email-test"
                disabled={test.kind === "pending"}
                onClick={runTest}
                type="button"
                variant="outline"
              >
                {test.kind === "pending"
                  ? t("auth_sending")
                  : t("setting_auth_email_test")}
              </Button>
              {test.kind === "sent" ? (
                <output
                  className="text-muted-foreground text-sm"
                  data-slot="auth-email-test-sent"
                >
                  {t("setting_auth_email_test_sent")}
                </output>
              ) : null}
            </div>
            {test.kind === "failed" ? (
              <TestFailure result={test.result} />
            ) : null}
          </FieldGroup>
        </CardContent>
        <SaveFooter refusals={channelMessages} view={saving} />
      </Card>
    </form>
  );
}

function TestFailure({
  result,
}: {
  readonly result: Extract<AuthTestResult, { ok: false }>;
}): ReactNode {
  const { t } = useMessages();
  if (result.reason === "failed" && result.failure) {
    return (
      <div data-slot="auth-email-test-failed">
        <SendFailureText failure={result.failure} />
      </div>
    );
  }
  return (
    <FieldError>
      {t(
        result.reason === "no_channel"
          ? "setting_auth_email_none"
          : "setting_unavailable"
      )}
    </FieldError>
  );
}

export interface SecondStepFormProps {
  readonly change: (input: SecondStepInput) => Promise<SecondStepResult>;
  readonly onChanged: () => void;
  readonly view: SecondStepView;
}

/** The second step's switch: its state, the current password, and one button that turns it the other way. */
export function SecondStepForm({
  change,
  onChanged,
  view,
}: SecondStepFormProps): ReactNode {
  const { t } = useMessages();
  const { fail, state, submit } = useSave(change, onChanged);
  let secondStepLabel = view.on
    ? t("setting_second_step_disable")
    : t("setting_second_step_enable");
  if (state.kind === "pending") {
    secondStepLabel = t("app_saving");
  }
  // Off can always be turned on only after a test; on can always be turned off.
  const locked = !(view.on || view.tested);
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const password = String(new FormData(form).get("password") ?? "");
      if (password === "") {
        fail("invalid");
        return;
      }
      submit({ on: !view.on, password });
      form.reset();
    },
    [fail, submit, view.on]
  );
  return (
    <form
      data-locked={locked}
      data-on={view.on}
      data-slot="second-step-form"
      method="post"
      onSubmit={onSubmit}
    >
      <Card>
        <CardHeader divided>
          <CardTitle>{t("setting_second_step_title")}</CardTitle>
          <CardDescription>{t("setting_second_step_intro")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <p className="font-medium text-sm" data-slot="second-step-state">
              {view.on
                ? t("setting_second_step_on")
                : t("setting_second_step_off")}
            </p>
            {view.on && view.app ? (
              <p className="text-muted-foreground text-sm">
                {t("setting_second_step_off_note")}
              </p>
            ) : null}
            {/* Locked, it says what opens it rather than show a field nobody can use. */}
            {locked ? (
              <p
                className="text-muted-foreground text-sm"
                data-slot="second-step-locked"
              >
                {t("setting_second_step_needs_test")}
              </p>
            ) : (
              <Field>
                <FieldLabel htmlFor="secondStepPassword">
                  {t("setting_password_current")}
                </FieldLabel>
                <Input
                  autoComplete="current-password"
                  id="secondStepPassword"
                  name="password"
                  required
                  type="password"
                />
              </Field>
            )}
          </FieldGroup>
        </CardContent>
        {locked ? null : (
          <FormFooter
            outcome={
              <SaveLine line={lineOf(state)} refusals={switchMessages} />
            }
          >
            <Button disabled={state.kind === "pending"} type="submit">
              {secondStepLabel}
            </Button>
          </FormFooter>
        )}
      </Card>
    </form>
  );
}
