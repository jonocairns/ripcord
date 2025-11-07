import { Permission } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { removeInvite } from '../../db/mutations/invites/remove-invite';
import { protectedProcedure } from '../../utils/trpc';

const deleteInviteRoute = protectedProcedure
  .input(
    z.object({
      inviteId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_INVITES);

    const removedInvite = await removeInvite(input.inviteId);

    if (!removedInvite) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    // TODO: Publish invite deletion event
    // ctx.pubsub.publish(ServerEvents.INVITE_DELETE, removedInvite.id);
  });

export { deleteInviteRoute };