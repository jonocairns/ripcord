import { streamEventBatchSchema } from '@sharkord/shared';
import { logger } from '../../logger';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

export const reportStreamEventsRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: 30,
	windowMs: 60_000,
	keyBy: 'user',
	logLabel: 'streamEvents',
})
	.input(streamEventBatchSchema)
	.mutation(({ input, ctx }) => {
		const receivedAt = Date.now();
		for (const event of input.events) {
			// Reporter identity is authenticated. remoteId is an untrusted claim about
			// a stream target, never authority to act on another user or channel.
			logger.info(
				'[stream-event] %s',
				JSON.stringify({
					...event,
					source: 'client',
					reporterUserId: ctx.user.id,
					clientSessionId: input.clientSessionId,
					clientVersion: input.clientVersion,
					droppedEvents: input.droppedEvents,
					receivedAt,
				}),
			);
		}
	});
