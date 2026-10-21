import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo } from "react";
import { PageSkeleton } from "@/admin/shell/page-skeleton.tsx";
import { type TeamCalls, TeamPage } from "@/admin/team/team-page.tsx";
import { readOperatorClockFn } from "@/routes/-monitors.ts";
import {
  changeRoleFn,
  deactivateFn,
  inviteAgainFn,
  inviteFn,
  reactivateFn,
  readTeamFn,
  removeFn,
  revokeInvitationFn,
  transferOwnershipFn,
} from "@/routes/-team.ts";

// The team page: the accounts and the invitations, for an owner or admin.
export const Route = createFileRoute("/admin/team")({
  component: TeamRoute,
  pendingComponent: () => <PageSkeleton action={[]} columns={6} />,
  loader: async ({ abortController: { signal } }) => {
    const [view, clock] = await Promise.all([
      readTeamFn({ signal }),
      readOperatorClockFn({ signal }),
    ]);
    return { clock, now: Date.now(), view };
  },
});

function TeamRoute() {
  const { clock, now, view } = Route.useLoaderData();
  const router = useRouter();
  // Through useServerFn, a redirect the permission check throws navigates.
  const invite = useServerFn(inviteFn);
  const inviteAgain = useServerFn(inviteAgainFn);
  const revoke = useServerFn(revokeInvitationFn);
  const changeRole = useServerFn(changeRoleFn);
  const deactivate = useServerFn(deactivateFn);
  const reactivate = useServerFn(reactivateFn);
  const remove = useServerFn(removeFn);
  const transfer = useServerFn(transferOwnershipFn);
  const calls = useMemo<TeamCalls>(
    () => ({
      changeRole: (data) => changeRole({ data }),
      deactivate: (data) => deactivate({ data }),
      invite: (data) => invite({ data }),
      inviteAgain: (id) => inviteAgain({ data: { id } }),
      reactivate: (id) => reactivate({ data: { id } }),
      remove: (data) => remove({ data }),
      revoke: (id) => revoke({ data: { id } }),
      transfer: (data) => transfer({ data }),
    }),
    [
      changeRole,
      deactivate,
      invite,
      inviteAgain,
      reactivate,
      remove,
      revoke,
      transfer,
    ]
  );
  const reread = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  return (
    <TeamPage
      calls={calls}
      clock={clock}
      now={now}
      onChanged={reread}
      view={view}
    />
  );
}
