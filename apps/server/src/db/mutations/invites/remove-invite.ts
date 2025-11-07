import type { TInvite } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { db } from '../..';
import { invites } from '../../schema';

const removeInvite = async (id: number): Promise<TInvite | undefined> =>
  db.delete(invites).where(eq(invites.id, id)).returning().get();

export { removeInvite };
