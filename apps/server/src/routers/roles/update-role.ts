import { ActivityLogType, OWNER_ROLE_ID, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { syncRolePermissions } from '../../db/mutations/roles';
import { publishRole } from '../../db/publishers';
import { getRole } from '../../db/queries/roles';
import { roles, userRoles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { revalidateActiveVoiceSessions } from '../../utils/revalidate-voice-sessions';
import { protectedProcedure } from '../../utils/trpc';

const updateRoleRoute = protectedProcedure
	.input(
		z.object({
			roleId: z.number().min(1),
			name: z.string().min(1).max(26),
			color: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color'),
			permissions: z.enum(Permission).array(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.MANAGE_ROLES);

		const existingRole = await getRole(input.roleId);

		invariant(existingRole, {
			code: 'NOT_FOUND',
			message: 'Role not found',
		});

		// Only newly granted permissions are checked, so a role holding permissions
		// the caller lacks can still be renamed or have permissions removed.
		const grantedPermissions = input.permissions.filter((permission) => !existingRole.permissions.includes(permission));

		invariant(await ctx.hasPermission(grantedPermissions), {
			code: 'FORBIDDEN',
			message: 'You cannot grant permissions that you do not have',
		});

		const affectedUsers = await db
			.select({ userId: userRoles.userId })
			.from(userRoles)
			.where(eq(userRoles.roleId, input.roleId));

		const updatedRole = await db
			.update(roles)
			.set({
				name: input.name,
				color: input.color,
			})
			.where(eq(roles.id, input.roleId))
			.returning()
			.get();

		if (updatedRole.id !== OWNER_ROLE_ID) {
			await syncRolePermissions(updatedRole.id, input.permissions);
		}

		await Promise.all([
			publishRole(updatedRole.id, 'update'),
			revalidateActiveVoiceSessions({
				userIds: affectedUsers.map((user) => user.userId),
			}),
		]);
		enqueueActivityLog({
			type: ActivityLogType.UPDATED_ROLE,
			userId: ctx.user.id,
			details: {
				roleId: updatedRole.id,
				permissions: input.permissions,
				values: input,
			},
		});
	});

export { updateRoleRoute };
