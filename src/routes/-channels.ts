/**
 * The channel server functions: the list, the channel page's
 * read, create, edit, delete and "send test", each behind its permission.
 * The email channel auth mail goes through is an owner's alone to change
 * (server/auth/mail.ts), and a generated secret is shown only to a role
 * that edits channels. Not a route file (the leading dash); the three
 * channel routes share them. A function parses with the Zod schema and calls
 * one module.
 */
import { createServerFn } from "@tanstack/react-start";
import { mayChangeChannel } from "@/server/auth/mail.ts";
import { smtpTimeoutMs } from "@/server/notify/channel.ts";
import {
  channelFormFor,
  createChannel,
  deleteChannel,
  editChannel,
  listChannels,
  readChannelForm,
  sendTest,
} from "@/server/notify/channels.ts";
import { can } from "@/shared/domain/roles.ts";
import {
  type ChannelDeleteResult,
  type ChannelFormResult,
  type ChannelListResult,
  type ChannelSaveResult,
  type ChannelTestResult,
  channelEditSchema,
  channelIdSchema,
  channelInputSchema,
} from "@/shared/schemas/channel.ts";
import { permitted } from "./-admin.ts";

const notAllowed = { ok: false, reason: "not_allowed" } as const;

export const readChannelListFn = createServerFn({ method: "GET" })
  .middleware([permitted("read")])
  .handler(
    ({ context }): Promise<ChannelListResult> =>
      listChannels(context.storage, context.boot.installKey)
  );

export const readChannelFormFn = createServerFn({ method: "GET" })
  .middleware([permitted("read")])
  .validator(channelIdSchema)
  .handler(async ({ context, data }): Promise<ChannelFormResult> => {
    const { role } = context.operator;
    const [result, changeable] = await Promise.all([
      readChannelForm(
        context.storage,
        context.boot.installKey,
        data.id,
        Date.now()
      ),
      mayChangeChannel(context.storage, context.operator, { id: data.id }),
    ]);
    return channelFormFor(result, {
      locked: can(role, "channels") && !changeable,
      reveal: can(role, "channels"),
    });
  });

export const createChannelFn = createServerFn({ method: "POST" })
  .middleware([permitted("channels")])
  .validator(channelInputSchema)
  .handler(async ({ context, data }): Promise<ChannelSaveResult> => {
    if (
      !(await mayChangeChannel(context.storage, context.operator, {
        type: data.type,
      }))
    ) {
      return notAllowed;
    }
    return createChannel(context.storage, context.boot.installKey, data);
  });

export const editChannelFn = createServerFn({ method: "POST" })
  .middleware([permitted("channels")])
  .validator(channelEditSchema)
  .handler(async ({ context, data }): Promise<ChannelSaveResult> => {
    if (
      !(await mayChangeChannel(context.storage, context.operator, {
        id: data.id,
      }))
    ) {
      return notAllowed;
    }
    return editChannel(
      context.storage,
      context.boot.installKey,
      data.id,
      data.input,
      { renewGenerated: data.renewGenerated }
    );
  });

export const deleteChannelFn = createServerFn({ method: "POST" })
  .middleware([permitted("channels")])
  .validator(channelIdSchema)
  .handler(async ({ context, data }): Promise<ChannelDeleteResult> => {
    if (
      !(await mayChangeChannel(context.storage, context.operator, {
        id: data.id,
      }))
    ) {
      return notAllowed;
    }
    return deleteChannel(context.storage, data.id);
  });

/** A test waits on the network for up to the longest attempt, an SMTP one, past Bun's ten idle seconds. */
const testHoldSeconds = smtpTimeoutMs / 1000 + 10;

export const sendTestFn = createServerFn({ method: "POST" })
  .middleware([permitted("channels")])
  .validator(channelIdSchema)
  .handler(({ context, data }): Promise<ChannelTestResult> => {
    context.holdOpen(testHoldSeconds);
    return sendTest(
      context.storage,
      context.boot.installKey,
      { fetch, now: Date.now },
      data.id
    );
  });
