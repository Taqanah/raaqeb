/**
 * The channel server functions: the list, the channel page's
 * read, create, edit, delete and "send test", each behind the operator
 * session check. Not a route file (the leading dash); the three channel
 * routes share them. A function parses with the Zod schema and calls one
 * module.
 */
import { createServerFn } from "@tanstack/react-start";
import { smtpTimeoutMs } from "@/server/notify/channel.ts";
import {
  createChannel,
  deleteChannel,
  editChannel,
  listChannels,
  readChannelForm,
  sendTest,
} from "@/server/notify/channels.ts";
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
import { operatorMiddleware } from "./-admin.ts";

export const readChannelListFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(
    ({ context }): Promise<ChannelListResult> =>
      listChannels(context.storage, context.boot.installKey)
  );

export const readChannelFormFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(channelIdSchema)
  .handler(
    ({ context, data }): Promise<ChannelFormResult> =>
      readChannelForm(
        context.storage,
        context.boot.installKey,
        data.id,
        Date.now()
      )
  );

export const createChannelFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(channelInputSchema)
  .handler(
    ({ context, data }): Promise<ChannelSaveResult> =>
      createChannel(context.storage, context.boot.installKey, data)
  );

export const editChannelFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(channelEditSchema)
  .handler(
    ({ context, data }): Promise<ChannelSaveResult> =>
      editChannel(
        context.storage,
        context.boot.installKey,
        data.id,
        data.input,
        {
          renewGenerated: data.renewGenerated,
        }
      )
  );

export const deleteChannelFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(channelIdSchema)
  .handler(
    ({ context, data }): Promise<ChannelDeleteResult> =>
      deleteChannel(context.storage, data.id)
  );

/** A test waits on the network for up to the longest attempt, an SMTP one, past Bun's ten idle seconds. */
const testHoldSeconds = smtpTimeoutMs / 1000 + 10;

export const sendTestFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
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
