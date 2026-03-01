import { OWNER_ROLE_ID } from '@sharkord/shared';
import { invariant } from '../../utils/invariant';
import type { Context } from '../../utils/trpc';
import { getUserRoles } from './get-user-roles';

const requireOwner = async (ctx: Context) => {
  const roles = await getUserRoles(ctx.userId);
  const isOwner = roles.some((role) => role.id === OWNER_ROLE_ID);

  invariant(isOwner, {
    code: 'FORBIDDEN',
    message: 'Only server owners can perform this action'
  });
};

export { requireOwner };
