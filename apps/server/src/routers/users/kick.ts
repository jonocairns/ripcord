import { ActivityLogType, DisconnectCode, Permission } from '@sharkord/shared';
import z from 'zod';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { revokeUserSessions } from '../../utils/user-sessions';

const kickRoute = protectedProcedure
	.input(
		z.object({
			userId: z.number(),
			reason: z.string().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.MANAGE_USERS);

		const kickedCount = revokeUserSessions(input.userId, {
			code: DisconnectCode.KICKED,
			reason: input.reason,
		});

		invariant(kickedCount > 0, {
			code: 'NOT_FOUND',
			message: 'User is not connected',
		});

		enqueueActivityLog({
			type: ActivityLogType.USER_KICKED,
			userId: input.userId,
			details: {
				reason: input.reason,
				kickedBy: ctx.userId,
			},
		});
	});

export { kickRoute };
