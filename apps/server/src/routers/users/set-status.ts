import { ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getPublicUserById } from '../../db/queries/users';
import { users } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const setStatusRoute = protectedProcedure
	.input(
		z.object({
			status: z.union([z.literal('online'), z.literal('away')]),
			auto: z.boolean().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		const isAuto = input.auto === true;

		// `presenceStatus` in the DB reflects the user's last *manual* choice —
		// auto flips don't persist. So an auto flip must not override a DB value
		// of 'away', since that means the user explicitly set themselves away.
		if (isAuto) {
			const row = await db
				.select({ presenceStatus: users.presenceStatus })
				.from(users)
				.where(eq(users.id, ctx.userId))
				.get();

			if (row?.presenceStatus === 'away') {
				return { status: ctx.getStatusById(ctx.userId) };
			}
		} else {
			await db.update(users).set({ presenceStatus: input.status }).where(eq(users.id, ctx.userId)).run();
		}

		ctx.setUserPresenceStatus(input.status);

		const user = await getPublicUserById(ctx.userId);

		invariant(user, {
			code: 'NOT_FOUND',
			message: 'User not found',
		});

		const status = ctx.getStatusById(ctx.userId);

		ctx.pubsub.publish(ServerEvents.USER_UPDATE, {
			...user,
			status,
		});

		return { status };
	});

export { setStatusRoute };
