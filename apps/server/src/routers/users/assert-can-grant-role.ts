import { OWNER_ROLE_ID, Permission, type TJoinedRole } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { channelRolePermissions } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import type { Context } from '../../utils/trpc';
import { requireOwner } from './require-owner';

// Handing out a role (directly or by making it the default) grants everything
// the role carries, so the caller must already hold all of it. Channel grants
// are gated on MANAGE_CHANNEL_PERMISSIONS, which already lets its holder open
// any private channel through overrides.
const assertCanGrantRole = async (ctx: Context, role: TJoinedRole) => {
	if (role.id === OWNER_ROLE_ID) {
		await requireOwner(ctx);
	}

	invariant(await ctx.hasPermission(role.permissions), {
		code: 'FORBIDDEN',
		message: 'You cannot assign a role with permissions that you do not have',
	});

	const channelGrant = await db
		.select({ roleId: channelRolePermissions.roleId })
		.from(channelRolePermissions)
		.where(and(eq(channelRolePermissions.roleId, role.id), eq(channelRolePermissions.allow, true)))
		.limit(1)
		.get();

	if (!channelGrant) return;

	invariant(await ctx.hasPermission(Permission.MANAGE_CHANNEL_PERMISSIONS), {
		code: 'FORBIDDEN',
		message: 'You need the Manage channel permissions permission to assign a role with channel permissions',
	});
};

export { assertCanGrantRole };
