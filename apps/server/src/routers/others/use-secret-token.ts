import { OWNER_ROLE_ID, sha256 } from '@sharkord/shared';
import crypto from 'crypto';
import { count, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { getSettings } from '../../db/queries/server';
import { settings, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

const useSecretTokenRoute = rateLimitedProcedure(protectedProcedure, {
  maxRequests: 5,
  windowMs: 60_000,
  logLabel: 'useSecretToken'
})
  .input(
    z.object({
      token: z.string()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const currentSettings = await getSettings();
    const hashedToken = await sha256(input.token);

    invariant(
      !!currentSettings.secretToken && hashedToken.length === currentSettings.secretToken.length,
      {
        code: 'FORBIDDEN',
        message: 'Invalid secret token'
      }
    );

    const validToken = crypto.timingSafeEqual(
      Buffer.from(hashedToken),
      Buffer.from(currentSettings.secretToken)
    );

    invariant(validToken, {
      code: 'FORBIDDEN',
      message: 'Invalid secret token'
    });

    const ownerCount = await db
      .select({ total: count(userRoles.userId) })
      .from(userRoles)
      .where(eq(userRoles.roleId, OWNER_ROLE_ID))
      .get();

    invariant((ownerCount?.total ?? 0) <= 1, {
      code: 'FORBIDDEN',
      message: 'Bootstrap token is no longer available'
    });

    await db.transaction(async (tx) => {
      await tx
        .insert(userRoles)
        .values({
          userId: ctx.userId,
          roleId: OWNER_ROLE_ID,
          createdAt: Date.now()
        })
        .onConflictDoNothing()
        .run();

      // First successful bootstrap claim closes open registration by default.
      await tx
        .update(settings)
        .set({
          allowNewUsers: false
        })
        .where(isNotNull(settings.name))
        .run();
    });

    publishUser(ctx.userId, 'update');
  });

export { useSecretTokenRoute };
