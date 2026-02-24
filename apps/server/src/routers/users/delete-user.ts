import { DisconnectCode, OWNER_ROLE_ID } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishUser } from '../../db/publishers';
import { isFileOrphaned } from '../../db/queries/files';
import { getUserById } from '../../db/queries/users';
import { files, users } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { getUserRoles } from './get-user-roles';

const deleteUserRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const callerRoles = await getUserRoles(ctx.userId);
    const isServerOwner = callerRoles.some((role) => role.id === OWNER_ROLE_ID);

    invariant(isServerOwner, {
      code: 'FORBIDDEN',
      message: 'Only the server owner can delete users'
    });

    const targetUser = await getUserById(input.userId);

    invariant(targetUser, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot delete yourself'
    });

    invariant(!targetUser.roleIds.includes(OWNER_ROLE_ID), {
      code: 'FORBIDDEN',
      message: 'Cannot delete the server owner'
    });

    const userWs = ctx.getUserWs(input.userId);

    if (userWs) {
      userWs.close(DisconnectCode.KICKED, 'Account deleted by server owner');
    }

    // Files are tracked with files.userId, not a foreign key to users,
    // so we clean up any files that become orphaned after deleting the user.
    const filesByUser = await db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.userId, input.userId))
      .all();

    const fileIds = [...new Set(filesByUser.map((file) => file.id))];

    await db.delete(users).where(eq(users.id, input.userId)).run();

    if (fileIds.length > 0) {
      await Promise.all(
        fileIds.map(async (fileId) => {
          if (await isFileOrphaned(fileId)) {
            await removeFile(fileId);
          }
        })
      );
    }

    publishUser(input.userId, 'delete');
  });

export { deleteUserRoute };
