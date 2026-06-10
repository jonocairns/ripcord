import { Permission } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { revalidateActiveVoiceSessions } from '../../utils/revalidate-voice-sessions';
import { protectedProcedure } from '../../utils/trpc';

const removeRoleRoute = protectedProcedure
	.input(
		z.object({
			userId: z.number(),
			roleId: z.number(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.MANAGE_USERS);

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
			revalidateActiveVoiceSessions({
				userIds: [input.userId],
			}),
		]);
	});

export { removeRoleRoute };
