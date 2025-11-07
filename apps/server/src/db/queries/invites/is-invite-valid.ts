import { eq } from 'drizzle-orm';
import { db } from '../..';
import { invites } from '../../schema';

const isInviteValid = async (
  code: string | undefined
): Promise<string | undefined> => {
  if (!code) {
    return 'Invalid invite code';
  }

  const invite = await db
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .get();

  if (!invite) {
    return 'Invite code not found';
  }

  if (invite.expiresAt && invite.expiresAt < Date.now()) {
    return 'Invite code has expired';
  }

  if (invite.maxUses && invite.uses >= invite.maxUses) {
    return 'Invite code has reached maximum uses';
  }

  return undefined;
};

export { isInviteValid };
