import type { TStorageData } from '@sharkord/shared';
import { count, eq, sum } from 'drizzle-orm';
import { db } from '../..';
import { files } from '../../schema';

const getStorageUsageByUserId = async (
  userId: number
): Promise<TStorageData> => {
  const result = await db
    .select({
      fileCount: count(files.id),
      usedStorage: sum(files.size)
    })
    .from(files)
    .where(eq(files.userId, userId))
    .get();

  return {
    userId,
    fileCount: result?.fileCount ?? 0,
    usedStorage: Number(result?.usedStorage ?? 0)
  };
};

export { getStorageUsageByUserId };
