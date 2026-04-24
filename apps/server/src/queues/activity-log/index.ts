import type { ActivityLogType, TActivityLogDetailsMap } from '@sharkord/shared';
import chalk from 'chalk';
import Queue from 'queue';
import { db } from '../../db';
import { activityLog } from '../../db/schema';
import { logger } from '../../logger';
import { getUserIp } from '../../utils/wss';

const activityLogQueue = new Queue({
  concurrency: 2,
  autostart: true,
  timeout: 3000
});

activityLogQueue.addEventListener('error', (event) => {
  logger.error('Activity log queue error', event.detail.error);
});

type TEnqueueActivityLogMetadata = {
  userId?: number;
  ip?: string;
};

type TEnqueueActivityLog = {
  [T in ActivityLogType]: TEnqueueActivityLogMetadata & {
    type: T;
    details?: TActivityLogDetailsMap[T];
  };
}[ActivityLogType];

const emptyActivityLogDetails: TActivityLogDetailsMap[ActivityLogType.SERVER_STARTED] =
  {};

const enqueueActivityLog = ({
  type,
  details,
  userId,
  ip
}: TEnqueueActivityLog) => {
  const date = Date.now();

  activityLogQueue.push(async (callback) => {
    const start = performance.now();

    await db.insert(activityLog).values({
      userId,
      type: type,
      details: details ?? emptyActivityLogDetails,
      ip: ip || (userId ? getUserIp(userId) : null),
      createdAt: date
    });

    logger.debug(
      `${chalk.dim('[Activity Logger]')} Logged activity of type ${type} for user ${userId} in ${(performance.now() - start).toFixed(2)} ms`
    );

    callback?.();
  });
};

export { enqueueActivityLog };
