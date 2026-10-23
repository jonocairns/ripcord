import { OWNER_ROLE_ID } from '@sharkord/shared';
import { invariant } from '../../utils/invariant';
import type { Context } from '../../utils/trpc';
import { getUserRoles } from './get-user-roles';

const isOwner = async (userId: number) => {
	const roles = await getUserRoles(userId);

	return roles.some((role) => role.id === OWNER_ROLE_ID);
};

const requireOwner = async (ctx: Context) => {
	invariant(await isOwner(ctx.userId), {
		code: 'FORBIDDEN',
		message: 'Only server owners can perform this action',
	});
};

// MANAGE_USERS must not reach the owner: without this a moderator could ban,
// kick or re-role the person who granted them the permission.
const assertCanActOnUser = async (ctx: Context, targetUserId: number) => {
	if (!(await isOwner(targetUserId))) return;

	invariant(await isOwner(ctx.userId), {
		code: 'FORBIDDEN',
		message: 'Only server owners can perform this action on a server owner',
	});
};

export { assertCanActOnUser, requireOwner };
