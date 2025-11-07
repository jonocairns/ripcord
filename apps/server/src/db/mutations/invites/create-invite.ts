import type { TIInvite, TInvite } from '@sharkord/shared';
import { db } from '../..';
import { invites } from '../../schema';

const createInvite = async (
  invite: Omit<TIInvite, 'createdAt'>
): Promise<TInvite | undefined> =>
  db
    .insert(invites)
    .values({
      ...invite,
      createdAt: Date.now()
    })
    .returning()
    .get();

export { createInvite };
