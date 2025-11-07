import type { TInvite } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { db } from '../..';
import { invites } from '../../schema';

const getInviteByCode = async (code: string): Promise<TInvite | undefined> =>
  db.select().from(invites).where(eq(invites.code, code)).get();

export { getInviteByCode };
