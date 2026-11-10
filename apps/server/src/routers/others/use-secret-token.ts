import { ActivityLogType, OWNER_ROLE_ID, sha256 } from '@sharkord/shared';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { getSettings } from '../../db/queries/server';
import { userRoles } from '../../db/schema';
import { logger } from '../../logger';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

const useSecretTokenRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: 5,
	windowMs: 15 * 60_000,
	keyBy: 'user',
	logLabel: 'useSecretToken',
})
	.input(
		z.object({
			token: z.string(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		const settings = await getSettings();
		const hashedToken = await sha256(input.token);

		if (hashedToken !== settings.secretToken) {
			logger.warn('Failed secret token attempt by user %d', ctx.userId);
		}

		invariant(hashedToken === settings.secretToken, {
			code: 'FORBIDDEN',
			message: 'Invalid secret token',
		});

		await db.insert(userRoles).values({
			userId: ctx.userId,
			roleId: OWNER_ROLE_ID,
			createdAt: Date.now(),
		});

		enqueueActivityLog({
			type: ActivityLogType.USER_USED_SECRET_TOKEN,
			userId: ctx.userId,
			details: {},
		});

		logger.info('Secret token used successfully by user %d', ctx.userId);
		publishUser(ctx.userId, 'update');
	});

export { useSecretTokenRoute };
