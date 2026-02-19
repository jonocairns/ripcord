import { ChannelPermission, Permission, ServerEvents } from '@sharkord/shared';
import { z } from 'zod';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { protectedProcedure } from '../../utils/trpc';

const signalTypingRoute = protectedProcedure
  .input(
    z
      .object({
        channelId: z.number()
      })
      .required()
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.SEND_MESSAGES);
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.SEND_MESSAGES
    );

    const affectedUserIds = await getAffectedUserIdsForChannel(input.channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });

    ctx.pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_TYPING, {
      channelId: input.channelId,
      userId: ctx.userId
    });
  });

export { signalTypingRoute };
