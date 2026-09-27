import { ActivityLogType, DisconnectCode } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { revokeUserSessions } from '../../utils/user-sessions';
import { requireOwner } from './require-owner';

const deleteUserRoute = protectedProcedure
	.input(
		z.object({
			userId: z.number().min(1),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await requireOwner(ctx);

		invariant(input.userId !== ctx.userId, {
			code: 'BAD_REQUEST',
			message: 'You cannot delete your own account',
		});

		const targetUser = await db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get();

		invariant(targetUser, {
			code: 'NOT_FOUND',
			message: 'User not found',
		});

		// Close before deleting: the close handler needs the user row to announce
		// USER_LEAVE. The auth-state cache is invalidated again by publishUser once
		// the row is gone.
		revokeUserSessions(input.userId, {
			code: DisconnectCode.KICKED,
			reason: 'Your account was deleted by a server owner.',
		});

		await db.delete(users).where(eq(users.id, input.userId)).run();

		publishUser(input.userId, 'delete');

		enqueueActivityLog({
			type: ActivityLogType.USER_DELETED,
			userId: ctx.userId,
			details: {
				targetUserId: input.userId,
				deletedBy: ctx.userId,
			},
		});
	});

export { deleteUserRoute };
