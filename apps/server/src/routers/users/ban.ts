import { ActivityLogType, DisconnectCode, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { revokeUserSessions } from '../../utils/user-sessions';

const banRoute = protectedProcedure
	.input(
		z.object({
			userId: z.number(),
			reason: z.string().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.MANAGE_USERS);

		invariant(input.userId !== ctx.user.id, {
			code: 'BAD_REQUEST',
			message: 'You cannot ban yourself.',
		});

		await db
			.update(users)
			.set({
				banned: true,
				banReason: input.reason ?? null,
				bannedAt: Date.now(),
			})
			.where(eq(users.id, input.userId));

		revokeUserSessions(input.userId, {
			code: DisconnectCode.BANNED,
			reason: input.reason,
		});

		publishUser(input.userId, 'update');

		enqueueActivityLog({
			type: ActivityLogType.USER_BANNED,
			userId: input.userId,
			details: {
				reason: input.reason,
				bannedBy: ctx.userId,
			},
		});
	});

export { banRoute };
