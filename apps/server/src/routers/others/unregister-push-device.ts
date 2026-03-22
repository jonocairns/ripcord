import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { pushDevices } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const unregisterPushDeviceRoute = protectedProcedure
  .input(
    z.object({
      installationId: z.string().min(1).max(255)
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .delete(pushDevices)
      .where(
        and(
          eq(pushDevices.userId, ctx.userId),
          eq(pushDevices.installationId, input.installationId)
        )
      );
  });

export { unregisterPushDeviceRoute };
