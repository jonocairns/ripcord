import { sum } from 'drizzle-orm';
import { db } from '../..';
import { files } from '../../schema';

const getUsedFileQuota = async (): Promise<number> => {
  const result = await db
    .select({
      usedSpace: sum(files.size)
    })
    .from(files)
    .get();

  return Number(result?.usedSpace ?? 0);
};

export { getUsedFileQuota };
