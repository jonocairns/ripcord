import { OWNER_ROLE_ID, Permission } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannelPermissions, publishUser, publishUserChannelVisibility } from '../../db/publishers';
import { userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { revalidateActiveVoiceSessions } from '../../utils/revalidate-voice-sessions';
import { protectedProcedure } from '../../utils/trpc';
import { assertCanActOnUser, requireOwner } from './require-owner';

const removeRoleRoute = protectedProcedure
	.input(
		z.object({
			userId: z.number(),
			roleId: z.number(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.MANAGE_USERS);

		if (input.roleId === OWNER_ROLE_ID) {
			await requireOwner(ctx);
		}

		await assertCanActOnUser(ctx, input.userId);

		const existing = await db
			.select()
			.from(userRoles)
			.where(and(eq(userRoles.userId, input.userId), eq(userRoles.roleId, input.roleId)))
			.limit(1);

		invariant(existing.length > 0, {
			code: 'NOT_FOUND',
			message: 'User does not have this role',
		});

		await db.delete(userRoles).where(and(eq(userRoles.userId, input.userId), eq(userRoles.roleId, input.roleId)));

		await Promise.all([
			publishUser(input.userId, 'update'),
			publishChannelPermissions([input.userId]),
			revalidateActiveVoiceSessions({
				userIds: [input.userId],
			}),
		]);
		await publishUserChannelVisibility([input.userId]);
	});

export { removeRoleRoute };
