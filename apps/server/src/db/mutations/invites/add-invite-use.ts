import { eq, sql } from 'drizzle-orm';
import { db } from '../..';
import { invites } from '../../schema';

const addInviteUse = async (code: string): Promise<void> => {
  await db
    .update(invites)
    .set({
      uses: sql`${invites.uses} + 1`
    })
    .where(eq(invites.code, code))
    .execute();
};

export { addInviteUse };
