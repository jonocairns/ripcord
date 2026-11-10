import { ActivityLogType, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { fallbackUsersToDefaultRoleSync } from '../../db/mutations/users';
import { publishChannelPermissions, publishRole, publishUserChannelVisibility } from '../../db/publishers';
import { getVisibleChannelIdsByUserSync } from '../../db/queries/channels';
import { getRole } from '../../db/queries/roles';
import { roles, userRoles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { revalidateActiveVoiceSessions } from '../../utils/revalidate-voice-sessions';
import { protectedProcedure } from '../../utils/trpc';

const deleteRoleRoute = protectedProcedure
	.input(
		z.object({
			roleId: z.number(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_ROLES);

		const role = await getRole(input.roleId);

		invariant(role, {
			code: 'NOT_FOUND',
			message: 'Role not found',
		});
		invariant(!role.isPersistent, {
			code: 'FORBIDDEN',
			message: 'Cannot delete a persistent role',
		});
		invariant(!role.isDefault, {
			code: 'FORBIDDEN',
			message: 'Cannot delete the default role',
		});

		const affectedUsers = await db
			.select({ userId: userRoles.userId })
			.from(userRoles)
			.where(eq(userRoles.roleId, role.id));

		const affectedUserIds = affectedUsers.map((user) => user.userId);
		const previousVisibleByUser = getVisibleChannelIdsByUserSync(affectedUserIds);

		db.transaction((tx) => {
			// Re-read inside the transaction: another admin may have deleted this role
			// or made it the default since the checks above. Deleting the default
			// would leave the server without one and break new sign-ups.
			const currentRole = tx.select({ isDefault: roles.isDefault }).from(roles).where(eq(roles.id, role.id)).get();
			invariant(currentRole, {
				code: 'NOT_FOUND',
				message: 'Role not found',
			});
			invariant(!currentRole.isDefault, {
				code: 'FORBIDDEN',
				message: 'Cannot delete the default role',
			});

			const defaultRole = tx.select({ id: roles.id }).from(roles).where(eq(roles.isDefault, true)).get();
			invariant(defaultRole, {
				code: 'NOT_FOUND',
				message: 'Default role not found',
			});

			fallbackUsersToDefaultRoleSync(tx, role.id, defaultRole.id);
			tx.delete(roles).where(eq(roles.id, role.id)).run();
		});

		// Order matters: permissions first (clients learn the channel is private
		// before they lose it), then visibility, then eviction, so users losing
		// access in the same change still receive the evicted member's leave.
		await Promise.all([publishRole(role.id, 'delete'), publishChannelPermissions(affectedUserIds)]);
		await publishUserChannelVisibility(affectedUserIds, previousVisibleByUser);
		await revalidateActiveVoiceSessions({
			userIds: affectedUserIds,
		});
		enqueueActivityLog({
			type: ActivityLogType.DELETED_ROLE,
			userId: ctx.user.id,
			details: {
				roleId: role.id,
				roleName: role.name,
			},
		});
	});

export { deleteRoleRoute };
