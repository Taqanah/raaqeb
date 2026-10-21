/**
 * The signed-in operator's role in the admin UI (CONTEXT.md "Role"): the
 * shell provides it from its first read, and every page asks `useCan` before
 * it offers an action, hiding a button or disabling a form with the reason.
 * The server checks every call again; this only keeps the page honest about
 * what will work. An operator who owes a second step an owner requires may
 * reach their own account alone.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { can, type Permission, type Role } from "@/shared/domain/roles.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { PageNotice } from "./page.tsx";
import { formPermissionOf } from "./role-gate.ts";
import { roleWords } from "./role-words.ts";

interface Standing {
  /** An owner requires a second step this operator has not switched on. */
  readonly pending: boolean;
  readonly role: Role;
}

// Nothing is offered until the shell says otherwise.
const StandingContext = createContext<Standing>({
  pending: false,
  role: "viewer",
});

export function RoleProvider({
  children,
  pending,
  role,
}: Standing & { readonly children: ReactNode }): ReactNode {
  const value = useMemo(() => ({ pending, role }), [pending, role]);
  return (
    <StandingContext.Provider value={value}>
      {children}
    </StandingContext.Provider>
  );
}

/** Whether a role allows a permission while it may be pending: only the operator's own account then. */
export function allows(standing: Standing, permission: Permission): boolean {
  return (
    (!standing.pending || permission === "profile") &&
    can(standing.role, permission)
  );
}

/** The signed-in operator's role. */
export function useRole(): Role {
  return useContext(StandingContext).role;
}

/** Whether the signed-in operator may do what the permission names. */
export function useCan(permission: Permission): boolean {
  return allows(useContext(StandingContext), permission);
}

/**
 * A page whose record the operator's role cannot change, shown read-only:
 * the reason above it and every field and button of it disabled, the
 * browser's own `fieldset disabled` doing the disabling. Any other page as
 * it is.
 */
export function FormGate({
  children,
  pathname,
}: {
  readonly children: ReactNode;
  readonly pathname: string;
}): ReactNode {
  const { t } = useMessages();
  const standing = useContext(StandingContext);
  const permission = formPermissionOf(pathname);
  if (permission === undefined || allows(standing, permission)) {
    return children;
  }
  // The page shows the reason under its header row.
  return (
    <PageNotice.Provider
      value={
        <Alert data-slot="read-only">
          <AlertDescription>
            {t("app_role_read_only", {
              role: t(roleWords[standing.role].name),
            })}
          </AlertDescription>
        </Alert>
      }
    >
      <fieldset className="contents" disabled>
        {children}
      </fieldset>
    </PageNotice.Provider>
  );
}

/** The test `useCan` makes, for a component that asks about several permissions. */
export function useAllows(): (permission: Permission) => boolean {
  const standing = useContext(StandingContext);
  return useCallback(
    (permission: Permission) => allows(standing, permission),
    [standing]
  );
}
