import { ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getPublicUserById } from '../../db/queries/users';
import { users } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const setStatusRoute = protectedProcedure
  .input(
    z.object({
      status: z.union([z.literal('online'), z.literal('away')])
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .update(users)
      .set({ presenceStatus: input.status })
      .where(eq(users.id, ctx.userId))
      .run();

    ctx.setUserPresenceStatus(input.status);

    const user = await getPublicUserById(ctx.userId);

    invariant(user, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const status = ctx.getStatusById(ctx.userId);

    ctx.pubsub.publish(ServerEvents.USER_UPDATE, {
      ...user,
      status
    });

    return { status };
  });

export { setStatusRoute };
