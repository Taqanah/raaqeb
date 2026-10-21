/** Each role's name and the line that says what it allows, as the catalog words them (CONTEXT.md "Role"). */
import type { Role } from "@/shared/domain/roles.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";

export const roleWords: Readonly<
  Record<Role, { readonly line: MessageId; readonly name: MessageId }>
> = {
  admin: { line: "team_role_admin_line", name: "team_role_admin" },
  editor: { line: "team_role_editor_line", name: "team_role_editor" },
  owner: { line: "team_role_owner_line", name: "team_role_owner" },
  responder: { line: "team_role_responder_line", name: "team_role_responder" },
  viewer: { line: "team_role_viewer_line", name: "team_role_viewer" },
};
