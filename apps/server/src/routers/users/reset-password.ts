import { ActivityLogType, DisconnectCode } from '@sharkord/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { refreshTokens, users } from '../../db/schema';
import { hashPassword } from '../../helpers/password';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { requireOwner } from './require-owner';

const resetPasswordRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number().min(1),
      newPassword: z.string().min(8).max(128)
    })
  )
  .mutation(async ({ ctx, input }) => {
    await requireOwner(ctx);

    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot reset your own password'
    });

    const targetUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .get();

    invariant(targetUser, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const now = Date.now();
    const hashedPassword = await hashPassword(input.newPassword);

    await db
      .update(users)
      .set({
        password: hashedPassword,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        mustChangePassword: true
      })
      .where(eq(users.id, input.userId))
      .run();

    await db
      .update(refreshTokens)
      .set({
        revokedAt: now,
        updatedAt: now
      })
      .where(
        and(eq(refreshTokens.userId, input.userId), isNull(refreshTokens.revokedAt))
      )
      .run();

    const userWss = ctx.getUserWss(input.userId);

    for (const userWs of userWss) {
      userWs.close(
        DisconnectCode.KICKED,
        'Your password was reset by a server owner. Please sign in again.'
      );
    }

    enqueueActivityLog({
      type: ActivityLogType.USER_RESET_PASSWORD,
      userId: ctx.userId,
      details: {
        targetUserId: input.userId,
        resetBy: ctx.userId
      }
    });
  });

export { resetPasswordRoute };
