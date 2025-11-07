import { getRandomString, Permission } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createInvite } from '../../db/mutations/invites/create-invite';
import { getInviteByCode } from '../../db/queries/invites/get-invite-by-code';
import { protectedProcedure } from '../../utils/trpc';

const addInviteRoute = protectedProcedure
  .input(
    z.object({
      maxUses: z.number().min(0).max(100).optional(),
      expiresAt: z.number().optional(),
      code: z.string().min(4).max(64).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_INVITES);

    const newCode = input.code || getRandomString(24);

    const existingInvite = await getInviteByCode(newCode);

    if (existingInvite) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Invite code should be unique'
      });
    }

    const invite = await createInvite({
      code: newCode,
      creatorId: ctx.userId,
      maxUses: input.maxUses || null,
      uses: 0,
      expiresAt: input.expiresAt || null
    });

    return invite;
  });

export { addInviteRoute };
