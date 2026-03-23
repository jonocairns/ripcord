import { ActivityLogType, DisconnectCode } from '@sharkord/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { refreshTokens, users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { requireOwner } from './require-owner';

const resetTotpRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number().min(1)
    })
  )
  .mutation(async ({ ctx, input }) => {
    await requireOwner(ctx);

    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot reset your own two-factor authentication'
    });

    const now = Date.now();

    await db.transaction(async (tx) => {
      const targetUser = await tx
        .select({
          id: users.id,
          totpSecret: users.totpSecret
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .get();

      invariant(targetUser, {
        code: 'NOT_FOUND',
        message: 'User not found'
      });

      invariant(targetUser.totpSecret, {
        code: 'BAD_REQUEST',
        message: 'Two-factor authentication is not enabled for this user'
      });

      await tx
        .update(users)
        .set({
          totpSecret: null,
          totpRecoveryCodes: null,
          tokenVersion: sql`${users.tokenVersion} + 1`
        })
        .where(eq(users.id, input.userId))
        .run();

      await tx
        .update(refreshTokens)
        .set({
          revokedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(refreshTokens.userId, input.userId),
            isNull(refreshTokens.revokedAt)
          )
        )
        .run();
    });

    const userWss = ctx.getUserWss(input.userId);

    for (const userWs of userWss) {
      userWs.close(
        DisconnectCode.KICKED,
        'Your two-factor authentication was reset by a server owner. Please sign in again.'
      );
    }

    enqueueActivityLog({
      type: ActivityLogType.USER_RESET_2FA,
      userId: ctx.userId,
      details: {
        targetUserId: input.userId,
        resetBy: ctx.userId
      }
    });
  });

export { resetTotpRoute };
