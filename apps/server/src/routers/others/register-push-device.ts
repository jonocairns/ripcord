import type { TPushDevicePlatform } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { pushDevices } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const registerPushDeviceRoute = protectedProcedure
  .input(
    z.object({
      installationId: z.string().min(1).max(255),
      expoPushToken: z.string().min(1).max(255),
      platform: z.enum(['ios', 'android', 'unknown'])
    })
  )
  .mutation(async ({ ctx, input }) => {
    const now = Date.now();
    const existing = await db
      .select({ id: pushDevices.id })
      .from(pushDevices)
      .where(
        and(
          eq(pushDevices.userId, ctx.userId),
          eq(pushDevices.installationId, input.installationId)
        )
      )
      .get();

    if (existing) {
      await db
        .update(pushDevices)
        .set({
          expoPushToken: input.expoPushToken,
          platform: input.platform satisfies TPushDevicePlatform,
          updatedAt: now
        })
        .where(eq(pushDevices.id, existing.id));

      return;
    }

    await db.insert(pushDevices).values({
      createdAt: now,
      expoPushToken: input.expoPushToken,
      installationId: input.installationId,
      platform: input.platform satisfies TPushDevicePlatform,
      updatedAt: now,
      userId: ctx.userId
    });
  });

export { registerPushDeviceRoute };
