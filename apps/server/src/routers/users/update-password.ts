import { ActivityLogType } from '@sharkord/shared';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { refreshTokens, users } from '../../db/schema';
import { hashPassword, verifyPassword } from '../../helpers/password';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const updatePasswordRoute = protectedProcedure
  .input(
    z.object({
      currentPassword: z.string().min(4).max(128),
      newPassword: z.string().min(8).max(128),
      confirmNewPassword: z.string().min(8).max(128)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const now = Date.now();
    const user = await db
      .select({
        password: users.password,
        mustChangePassword: users.mustChangePassword
      })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .get();

    invariant(user, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const isCurrentPasswordValid = await verifyPassword(
      input.currentPassword,
      user.password
    );

    if (!isCurrentPasswordValid) {
      ctx.throwValidationError(
        'currentPassword',
        'Current password is incorrect'
      );
    }

    if (input.newPassword !== input.confirmNewPassword) {
      ctx.throwValidationError(
        'confirmNewPassword',
        'New password and confirmation do not match'
      );
    }

    const hashedNewPassword = await hashPassword(input.newPassword);

    const shouldRotateSessions = user.mustChangePassword;
    const userUpdateData: {
      password: string;
      mustChangePassword: boolean;
      tokenVersion?: SQL;
    } = {
      password: hashedNewPassword,
      mustChangePassword: false
    };

    if (shouldRotateSessions) {
      userUpdateData.tokenVersion = sql`${users.tokenVersion} + 1`;
    }

    await db
      .update(users)
      .set(userUpdateData)
      .where(eq(users.id, ctx.userId))
      .run();

    if (shouldRotateSessions) {
      await db
        .update(refreshTokens)
        .set({
          revokedAt: now,
          updatedAt: now
        })
        .where(
          and(eq(refreshTokens.userId, ctx.userId), isNull(refreshTokens.revokedAt))
        )
        .run();
    }

    enqueueActivityLog({
      type: ActivityLogType.USER_UPDATED_PASSWORD,
      userId: ctx.user.id
    });
  });

export { updatePasswordRoute };
