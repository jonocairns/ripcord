import { loadUserGrants } from '../../db/queries/permissions';
import { invariant } from '../../utils/invariant';
import type { Context } from '../../utils/trpc';

const isOwner = async (userId: number) => loadUserGrants(userId)?.isOwner === true;

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

export { assertCanActOnUser, isOwner, requireOwner };
