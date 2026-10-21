/**
 * The team page (CONTEXT.md "Operator account", "Role", "Invitation",
 * "Deactivated"): every account with its role, whether it is active, its
 * second step and its last sign-in, and the invitations not accepted yet.
 * An owner or admin invites, changes roles, deactivates, reactivates and
 * removes the accounts their role manages; an owner also hands ownership on.
 * What the signed-in operator may not do to a row is disabled with the
 * reason; their own row is changed on the account page.
 */
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Page } from "@/admin/shell/page.tsx";
import { roleWords } from "@/admin/shell/role-words.ts";
import type { Role } from "@/shared/domain/roles.ts";
import { roles } from "@/shared/domain/roles.ts";
import { formatDateTime, type TimeOptions } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  AccountActionInput,
  Invitation,
  InviteInput,
  InviteRefusal,
  InviteResult,
  OwnershipTransferInput,
  RoleChangeInput,
  TeamMember,
  TeamRefusal,
  TeamResult,
  TeamView,
} from "@/shared/schemas/team.ts";
import { inviteSchema } from "@/shared/schemas/team.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { CopyButton } from "@/shared/ui/copy-button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { EllipsisIcon, PlusIcon } from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";

/** What the page calls; each answers a result and never throws, a rejected call reading as unavailable. */
export interface TeamCalls {
  readonly changeRole: (input: RoleChangeInput) => Promise<TeamResult>;
  readonly deactivate: (input: AccountActionInput) => Promise<TeamResult>;
  readonly invite: (input: InviteInput) => Promise<InviteResult>;
  readonly inviteAgain: (id: string) => Promise<InviteResult>;
  readonly reactivate: (id: string) => Promise<TeamResult>;
  readonly remove: (input: AccountActionInput) => Promise<TeamResult>;
  readonly revoke: (id: string) => Promise<TeamResult>;
  readonly transfer: (input: OwnershipTransferInput) => Promise<TeamResult>;
}

const refusals: Readonly<
  Record<InviteRefusal | TeamRefusal | "unavailable", MessageId>
> = {
  already_member: "team_refused_already_member",
  invalid: "team_refused_invalid",
  no_address: "team_refused_no_address",
  not_allowed: "team_refused_not_allowed",
  not_found: "team_refused_not_found",
  self: "team_refused_self",
  too_many: "team_refused_too_many",
  too_many_attempts: "setting_password_too_many",
  unavailable: "team_unavailable",
  wrong_password: "team_refused_wrong_password",
};

type Outcome<Refusal extends string> =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Refusal };

/** Hands a call's result on, a rejected call (the server unreachable) as unavailable. */
function settle<Result extends Outcome<string>>(
  call: Promise<Result>,
  done: (
    result: Result | { readonly ok: false; readonly reason: "unavailable" }
  ) => void
): void {
  call.then(done, () => done({ ok: false, reason: "unavailable" }));
}

export interface TeamPageProps {
  readonly calls: TeamCalls;
  readonly clock: TimeOptions;
  /** The time the page read the team at, for which invitations have expired. */
  readonly now: number;
  readonly onChanged: () => void;
  /** Nothing when the team could not be read. */
  readonly view: TeamView | undefined;
}

export function TeamPage({
  calls,
  clock,
  now,
  onChanged,
  view,
}: TeamPageProps): ReactNode {
  const { t } = useMessages();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<
    { readonly emailed: boolean; readonly link: string } | undefined
  >();
  const shown = useCallback(
    (result: { readonly emailed: boolean; readonly link: string }) => {
      setInviting(false);
      setLink(result);
      onChanged();
    },
    [onChanged]
  );
  const openInvite = useCallback(() => setInviting(true), []);
  const closeLink = useCallback(() => setLink(undefined), []);
  if (!view) {
    return (
      <Page title={t("team_title")}>
        <Alert variant="destructive">
          <AlertDescription>{t("team_unavailable")}</AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <Page
      action={
        <Button data-slot="team-invite" onClick={openInvite} type="button">
          <PlusIcon />
          {t("team_invite")}
        </Button>
      }
      title={t("team_title")}
    >
      <p className="text-muted-foreground text-sm">{t("team_intro")}</p>
      <section aria-labelledby="team-accounts" className="flex flex-col gap-3">
        <h2 className="font-medium" id="team-accounts">
          {t("team_accounts")}
        </h2>
        <Table data-slot="team-members" framed stacked>
          <TableHeader>
            <TableRow>
              <TableHead>{t("team_name")}</TableHead>
              <TableHead>{t("team_role")}</TableHead>
              <TableHead>{t("team_status")}</TableHead>
              <TableHead>{t("team_second_step")}</TableHead>
              <TableHead>{t("team_last_sign_in")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("team_actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.members.map((member) => (
              <MemberRow
                calls={calls}
                clock={clock}
                key={member.account.id}
                member={member}
                onChanged={onChanged}
                ownership={view.ownership}
              />
            ))}
          </TableBody>
        </Table>
      </section>
      {view.invitations.length > 0 ? (
        <section
          aria-labelledby="team-invitations"
          className="flex flex-col gap-3"
        >
          <h2 className="font-medium" id="team-invitations">
            {t("team_invitations")}
          </h2>
          <Table data-slot="team-invitations" framed stacked>
            <TableHeader>
              <TableRow>
                <TableHead>{t("auth_email")}</TableHead>
                <TableHead>{t("team_role")}</TableHead>
                <TableHead>{t("team_sent_by")}</TableHead>
                <TableHead>{t("team_expires")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("team_actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.invitations.map((invitation) => (
                <InvitationRow
                  calls={calls}
                  clock={clock}
                  invitable={view.invitable}
                  invitation={invitation}
                  key={invitation.id}
                  now={now}
                  onChanged={onChanged}
                  onShown={shown}
                />
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
      <InviteDialog
        invitable={view.invitable}
        invite={calls.invite}
        onOpenChange={setInviting}
        onSent={shown}
        open={inviting}
      />
      <LinkDialog link={link} mail={view.mail} onClose={closeLink} />
    </Page>
  );
}

function MemberRow({
  calls,
  clock,
  member,
  onChanged,
  ownership,
}: {
  readonly calls: TeamCalls;
  readonly clock: TimeOptions;
  readonly member: TeamMember;
  readonly onChanged: () => void;
  readonly ownership: boolean;
}): ReactNode {
  const { locale, t } = useMessages();
  const { account } = member;
  const [asked, setAsked] = useState<Asked | undefined>();
  const [refused, setRefused] = useState<MessageId | undefined>();
  const close = useCallback(() => setAsked(undefined), []);
  const done = useCallback(
    (result: Outcome<string>) => {
      if (result.ok) {
        setAsked(undefined);
        setRefused(undefined);
        onChanged();
        return true;
      }
      return false;
    },
    [onChanged]
  );
  const onRole = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const chosen = roles.find((role) => role === event.currentTarget.value);
    if (chosen) {
      setAsked({ kind: "role", role: chosen });
    }
  }, []);
  const reactivate = useCallback(() => {
    settle(calls.reactivate(account.id), (result) => {
      if (!(done(result) || result.ok)) {
        setRefused(refusals[result.reason]);
      }
    });
  }, [account.id, calls, done]);
  const deactivated = account.deactivatedAt !== null;
  // Why the row offers nothing, for the one that cannot be changed here.
  let reason: MessageId | undefined;
  if (member.self) {
    reason = "team_self_here";
  } else if (!member.manageable) {
    reason = "team_owner_only";
  }
  const name = account.name === "" ? account.email : account.name;
  return (
    <TableRow
      data-account={account.id}
      data-role={account.role}
      data-slot="team-member"
      data-state={deactivated ? "deactivated" : "active"}
    >
      <TableCell className="min-w-56">
        <div className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 font-medium">
            <bdi>{name}</bdi>
            {member.self ? (
              <Badge variant="secondary">{t("team_you")}</Badge>
            ) : null}
          </span>
          {account.name === "" ? null : (
            <Token className="wrap-anywhere self-start text-muted-foreground">
              {account.email}
            </Token>
          )}
        </div>
      </TableCell>
      <TableCell label={t("team_role")}>
        {member.assignable.length > 0 && !deactivated ? (
          <NativeSelect
            aria-label={t("team_change_role")}
            data-slot="team-role"
            onChange={onRole}
            value={account.role}
          >
            {member.assignable.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {t(roleWords[role].name)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <span data-slot="team-role-name">
            {t(roleWords[account.role].name)}
          </span>
        )}
      </TableCell>
      <TableCell label={t("team_status")}>
        <Badge variant={deactivated ? "secondary" : "up"}>
          {deactivated ? t("team_deactivated") : t("team_active")}
        </Badge>
      </TableCell>
      <TableCell label={t("team_second_step")}>
        {secondStepWords(account, t)}
      </TableCell>
      <TableCell
        className="text-muted-foreground"
        label={t("team_last_sign_in")}
      >
        {account.lastSignInAt === null
          ? t("team_never_signed_in")
          : formatDateTime(locale, account.lastSignInAt, clock)}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-end gap-1">
          {reason ? (
            <Button
              aria-label={t("team_actions")}
              data-slot="team-actions"
              disabled
              size="icon"
              title={t(reason)}
              type="button"
              variant="ghost"
            >
              <EllipsisIcon />
            </Button>
          ) : (
            <MemberMenu
              deactivated={deactivated}
              onAsk={setAsked}
              onReactivate={reactivate}
              transferable={ownership && account.role !== "owner"}
            />
          )}
          {refused ? (
            <p className="text-destructive text-xs" role="alert">
              {t(refused)}
            </p>
          ) : null}
        </div>
        {asked ? (
          <MemberDialog
            account={account}
            asked={asked}
            calls={calls}
            onClose={close}
            onDone={done}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

type Asked =
  | { readonly kind: "role"; readonly role: Role }
  | { readonly kind: "deactivate" | "remove" | "transfer" };

/** A managed account's menu: deactivate or reactivate, hand ownership on, remove. */
function MemberMenu({
  deactivated,
  onAsk,
  onReactivate,
  transferable,
}: {
  readonly deactivated: boolean;
  readonly onAsk: (asked: Asked) => void;
  readonly onReactivate: () => void;
  /** The signed-in operator may hand ownership on to this account. */
  readonly transferable: boolean;
}): ReactNode {
  const { t } = useMessages();
  const deactivate = useCallback(() => onAsk({ kind: "deactivate" }), [onAsk]);
  const transfer = useCallback(() => onAsk({ kind: "transfer" }), [onAsk]);
  const remove = useCallback(() => onAsk({ kind: "remove" }), [onAsk]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("team_actions")}
            className="text-muted-foreground"
            data-slot="team-actions"
            size="icon"
            type="button"
            variant="ghost"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {deactivated ? (
          <DropdownMenuItem data-action="reactivate" onClick={onReactivate}>
            {t("team_reactivate")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem data-action="deactivate" onClick={deactivate}>
            {t("team_deactivate")}
          </DropdownMenuItem>
        )}
        {transferable && !deactivated ? (
          <DropdownMenuItem data-action="transfer" onClick={transfer}>
            {t("team_transfer")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-action="remove"
          onClick={remove}
          variant="destructive"
        >
          {t("team_remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The dialog that confirms what was asked of an account's row. */
function MemberDialog({
  account,
  asked,
  calls,
  onClose,
  onDone,
}: {
  readonly account: TeamMember["account"];
  readonly asked: Asked;
  readonly calls: TeamCalls;
  readonly onClose: () => void;
  readonly onDone: (result: Outcome<string>) => boolean;
}): ReactNode {
  const { t } = useMessages();
  const { id } = account;
  const transfer = useCallback(
    (password: string) => calls.transfer({ id, password }),
    [calls, id]
  );
  const remove = useCallback(
    (password?: string) => calls.remove({ id, password }),
    [calls, id]
  );
  const deactivate = useCallback(
    (password?: string) => calls.deactivate({ id, password }),
    [calls, id]
  );
  // Taking an owner's account away asks for the password, as taking the owner role does.
  const owner = account.role === "owner";
  if (owner && (asked.kind === "remove" || asked.kind === "deactivate")) {
    const removing = asked.kind === "remove";
    return (
      <PasswordDialog
        description={t("team_owner_password")}
        email={account.email}
        extra={
          <DialogDescription>
            {t(
              removing
                ? "team_remove_description"
                : "team_deactivate_description"
            )}
          </DialogDescription>
        }
        onClose={onClose}
        onDone={onDone}
        run={removing ? remove : deactivate}
        slot={removing ? "team-remove" : "team-deactivate"}
        submit={t(removing ? "team_remove" : "team_deactivate")}
        title={t(removing ? "team_remove_title" : "team_deactivate_title")}
        tone="destructive"
      />
    );
  }
  switch (asked.kind) {
    case "role":
      return (
        <RoleDialog
          account={account}
          change={calls.changeRole}
          onClose={onClose}
          onDone={onDone}
          role={asked.role}
        />
      );
    case "transfer":
      return (
        <PasswordDialog
          description={t("team_transfer_description")}
          email={account.email}
          onClose={onClose}
          onDone={onDone}
          run={transfer}
          slot="team-transfer"
          submit={t("team_transfer")}
          title={t("team_transfer_title")}
        />
      );
    case "remove":
      return (
        <ConfirmDialog
          description={t("team_remove_description")}
          email={account.email}
          onClose={onClose}
          onDone={onDone}
          run={remove}
          slot="team-remove"
          submit={t("team_remove")}
          title={t("team_remove_title")}
        />
      );
    default:
      return (
        <ConfirmDialog
          description={t("team_deactivate_description")}
          email={account.email}
          onClose={onClose}
          onDone={onDone}
          run={deactivate}
          slot="team-deactivate"
          submit={t("team_deactivate")}
          title={t("team_deactivate_title")}
        />
      );
  }
}

function secondStepWords(
  account: TeamMember["account"],
  t: (id: MessageId) => string
): string {
  if (!account.secondStep) {
    return t("team_second_step_off");
  }
  return account.app ? t("team_second_step_app") : t("team_second_step_email");
}

/** Confirms a role change; giving or taking the owner role asks for the signed-in owner's password. */
function RoleDialog({
  account,
  change,
  onClose,
  onDone,
  role,
}: {
  readonly account: TeamMember["account"];
  readonly change: (input: RoleChangeInput) => Promise<TeamResult>;
  readonly onClose: () => void;
  readonly onDone: (result: Outcome<string>) => boolean;
  readonly role: Role;
}): ReactNode {
  const { t } = useMessages();
  const ownership = role === "owner" || account.role === "owner";
  const lower = roles.indexOf(role) > roles.indexOf(account.role);
  const lines = (
    <>
      <DialogDescription>{t(roleWords[role].line)}</DialogDescription>
      {lower ? (
        <DialogDescription>{t("team_change_role_lower")}</DialogDescription>
      ) : null}
    </>
  );
  const { id } = account;
  const withPassword = useCallback(
    (password: string) => change({ id, password, role }),
    [change, id, role]
  );
  const without = useCallback(() => change({ id, role }), [change, id, role]);
  const title = t("team_change_role_title", { role: t(roleWords[role].name) });
  return ownership ? (
    <PasswordDialog
      description={t("team_owner_password")}
      email={account.email}
      extra={lines}
      onClose={onClose}
      onDone={onDone}
      run={withPassword}
      slot="team-role-change"
      submit={t("team_change_role")}
      title={title}
    />
  ) : (
    <ConfirmDialog
      description={t(roleWords[role].line)}
      email={account.email}
      extra={
        lower ? (
          <AlertDialogDescription>
            {t("team_change_role_lower")}
          </AlertDialogDescription>
        ) : null
      }
      onClose={onClose}
      onDone={onDone}
      run={without}
      slot="team-role-change"
      submit={t("team_change_role")}
      title={title}
      tone={lower ? "destructive" : "default"}
    />
  );
}

/** An alert asking to confirm one change of an account, naming it. */
function ConfirmDialog({
  description,
  email,
  extra,
  onClose,
  onDone,
  run,
  slot,
  submit,
  title,
  tone = "destructive",
}: {
  readonly description: string;
  readonly email: string;
  readonly extra?: ReactNode;
  readonly onClose: () => void;
  readonly onDone: (result: Outcome<string>) => boolean;
  readonly run: () => Promise<Outcome<InviteRefusal | TeamRefusal>>;
  readonly slot: string;
  readonly submit: string;
  readonly title: string;
  /** A change that takes nothing away (a higher role) confirms with the plain button. */
  readonly tone?: "destructive" | "default";
}): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<MessageId | undefined>();
  const confirm = useCallback(() => {
    setPending(true);
    settle(run(), (result) => {
      setPending(false);
      if (!(onDone(result) || result.ok)) {
        setRefused(refusals[result.reason]);
      }
    });
  }, [onDone, run]);
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <AlertDialog onOpenChange={changeOpen} open>
      <AlertDialogContent data-slot={slot}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <p>
            <Token>{email}</Token>
          </p>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          {extra}
        </AlertDialogHeader>
        {refused ? (
          <FieldError data-slot="team-refused">{t(refused)}</FieldError>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
          <Button
            data-slot="team-confirm"
            disabled={pending}
            onClick={confirm}
            type="button"
            variant={tone}
          >
            {submit}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A dialog that confirms a change with the signed-in operator's password. */
function PasswordDialog({
  description,
  email,
  extra,
  onClose,
  onDone,
  run,
  slot,
  submit,
  title,
  tone = "default",
}: {
  readonly description: string;
  readonly email: string;
  readonly extra?: ReactNode;
  readonly onClose: () => void;
  readonly onDone: (result: Outcome<string>) => boolean;
  readonly run: (password: string) => Promise<Outcome<TeamRefusal>>;
  readonly slot: string;
  readonly submit: string;
  readonly title: string;
  readonly tone?: "default" | "destructive";
}): ReactNode {
  const { t } = useMessages();
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<MessageId | undefined>();
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const password = String(
        new FormData(event.currentTarget).get("password") ?? ""
      );
      if (password === "") {
        setRefused("auth_password_required");
        return;
      }
      setPending(true);
      settle(run(password), (result) => {
        setPending(false);
        if (!(onDone(result) || result.ok)) {
          setRefused(refusals[result.reason]);
        }
      });
    },
    [onDone, run]
  );
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <Dialog onOpenChange={changeOpen} open>
      <DialogContent data-slot={slot}>
        <form
          className="grid gap-4"
          method="post"
          noValidate
          onSubmit={onSubmit}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <p>
              <Token>{email}</Token>
            </p>
            {extra}
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${slot}-password`}>
              {t("team_your_password")}
            </FieldLabel>
            <Input
              aria-invalid={refused ? true : undefined}
              autoComplete="current-password"
              autoFocus
              id={`${slot}-password`}
              name="password"
              required
              type="password"
            />
            {refused ? (
              <FieldError data-slot="team-refused">{t(refused)}</FieldError>
            ) : null}
          </Field>
          <DialogFooter>
            <Button disabled={pending} type="submit" variant={tone}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InvitationRow({
  calls,
  clock,
  invitable,
  invitation,
  now,
  onChanged,
  onShown,
}: {
  readonly calls: TeamCalls;
  readonly clock: TimeOptions;
  readonly invitable: readonly Role[];
  readonly invitation: Invitation & { readonly invitedByName?: string };
  readonly now: number;
  readonly onChanged: () => void;
  readonly onShown: (result: {
    readonly emailed: boolean;
    readonly link: string;
  }) => void;
}): ReactNode {
  const { locale, t } = useMessages();
  const [revoking, setRevoking] = useState(false);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<MessageId | undefined>();
  const expired = invitation.expiresAt <= now;
  // An owner's invitation is an owner's alone to send again or revoke.
  const mine = invitable.includes(invitation.role);
  const again = useCallback(() => {
    setPending(true);
    settle(calls.inviteAgain(invitation.id), (result) => {
      setPending(false);
      if (result.ok) {
        setRefused(undefined);
        onShown(result);
      } else {
        setRefused(refusals[result.reason]);
      }
    });
  }, [calls, invitation.id, onShown]);
  const askRevoke = useCallback(() => setRevoking(true), []);
  const revoke = useCallback(
    () => calls.revoke(invitation.id),
    [calls, invitation.id]
  );
  const closeRevoke = useCallback(() => setRevoking(false), []);
  const revoked = useCallback(
    (result: Outcome<string>) => {
      if (result.ok) {
        setRevoking(false);
        onChanged();
        return true;
      }
      return false;
    },
    [onChanged]
  );
  return (
    <TableRow
      data-invitation={invitation.id}
      data-slot="team-invitation"
      data-state={expired ? "expired" : "pending"}
    >
      <TableCell className="min-w-56">
        <Token className="wrap-anywhere">{invitation.email}</Token>
      </TableCell>
      <TableCell label={t("team_role")}>
        {t(roleWords[invitation.role].name)}
      </TableCell>
      <TableCell label={t("team_sent_by")}>
        {invitation.invitedByName === undefined ? (
          <span className="text-muted-foreground">–</span>
        ) : (
          <bdi>{invitation.invitedByName}</bdi>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground" label={t("team_expires")}>
        {expired ? (
          <Badge variant="secondary">{t("team_expired")}</Badge>
        ) : (
          formatDateTime(locale, invitation.expiresAt, clock)
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              data-slot="invitation-again"
              disabled={!mine || pending}
              onClick={again}
              size="sm"
              title={mine ? undefined : t("team_owner_only")}
              type="button"
              variant="outline"
            >
              {t("team_invite_again")}
            </Button>
            <Button
              data-slot="invitation-revoke"
              disabled={!mine}
              onClick={askRevoke}
              size="sm"
              title={mine ? undefined : t("team_owner_only")}
              type="button"
              variant="ghost"
            >
              {t("team_revoke")}
            </Button>
          </div>
          {refused ? (
            <p className="text-destructive text-xs" role="alert">
              {t(refused)}
            </p>
          ) : null}
        </div>
        {revoking ? (
          <ConfirmDialog
            description={t("team_revoke_description")}
            email={invitation.email}
            onClose={closeRevoke}
            onDone={revoked}
            run={revoke}
            slot="team-revoke"
            submit={t("team_revoke")}
            title={t("team_revoke_title")}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function InviteDialog({
  invitable,
  invite,
  onOpenChange,
  onSent,
  open,
}: {
  readonly invitable: readonly Role[];
  readonly invite: (input: InviteInput) => Promise<InviteResult>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSent: (result: {
    readonly emailed: boolean;
    readonly link: string;
  }) => void;
  readonly open: boolean;
}): ReactNode {
  const { t } = useMessages();
  // The least role is offered first, so an invitation never gives more than was meant.
  const [role, setRole] = useState<Role>(invitable.at(-1) ?? "viewer");
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<MessageId | undefined>();
  const onRole = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const chosen = roles.find((one) => one === event.currentTarget.value);
    if (chosen) {
      setRole(chosen);
    }
  }, []);
  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = inviteSchema.safeParse({
        email: String(new FormData(event.currentTarget).get("email") ?? "")
          .trim()
          .toLowerCase(),
        role,
      });
      if (!parsed.success) {
        setRefused("team_refused_invalid");
        return;
      }
      setPending(true);
      setRefused(undefined);
      settle(invite(parsed.data), (result) => {
        setPending(false);
        if (result.ok) {
          onSent(result);
        } else {
          setRefused(refusals[result.reason]);
        }
      });
    },
    [invite, onSent, role]
  );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-slot="team-invite-dialog">
        <form
          className="grid gap-4"
          method="post"
          noValidate
          onSubmit={onSubmit}
        >
          <DialogHeader>
            <DialogTitle>{t("team_invite")}</DialogTitle>
            <DialogDescription>
              {t("team_invite_description")}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="inviteEmail">{t("auth_email")}</FieldLabel>
              <Input
                aria-invalid={
                  refused === "team_refused_invalid" ? true : undefined
                }
                autoComplete="off"
                autoFocus
                dir="ltr"
                id="inviteEmail"
                name="email"
                required
                type="email"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="inviteRole">{t("team_role")}</FieldLabel>
              <NativeSelect
                className="w-full"
                id="inviteRole"
                name="role"
                onChange={onRole}
                value={role}
              >
                {invitable.map((one) => (
                  <NativeSelectOption key={one} value={one}>
                    {t(roleWords[one].name)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription data-slot="invite-role-line">
                {t(roleWords[role].line)}
              </FieldDescription>
            </Field>
            {refused ? (
              <FieldError data-slot="team-refused">{t(refused)}</FieldError>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              data-slot="team-invite-send"
              disabled={pending}
              type="submit"
            >
              {pending ? t("auth_sending") : t("team_invite_send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The link of an invitation just sent, shown once with its copy button. */
function LinkDialog({
  link,
  mail,
  onClose,
}: {
  readonly link:
    | { readonly emailed: boolean; readonly link: string }
    | undefined;
  readonly mail: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { t } = useMessages();
  const shown = useRef<HTMLElement>(null);
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  let line: MessageId = "team_link_copy_only";
  if (link?.emailed) {
    line = "team_link_emailed";
  } else if (mail) {
    line = "team_link_not_emailed";
  }
  return (
    <Dialog onOpenChange={changeOpen} open={link !== undefined}>
      <DialogContent data-slot="team-link">
        <DialogHeader>
          <DialogTitle>{t("team_link_title")}</DialogTitle>
          <DialogDescription
            data-emailed={link?.emailed}
            data-slot="team-link-line"
          >
            {t(line)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Token
            className="wrap-anywhere block select-all py-1"
            data-slot="team-link-value"
            ref={shown}
          >
            {link?.link ?? ""}
          </Token>
          <CopyButton
            className="self-start"
            data-copy="team-link"
            size="sm"
            target={shown}
            text={link?.link ?? ""}
          />
        </div>
        <p className="text-muted-foreground text-xs">{t("team_link_once")}</p>
        <DialogFooter>
          <Button data-slot="team-link-done" onClick={onClose} type="button">
            {t("team_done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
