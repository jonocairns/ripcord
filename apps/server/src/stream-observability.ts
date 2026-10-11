import { streamEventDetailsSchema, type TStreamEventDetails } from '@sharkord/shared';
import { logger } from './logger';

export const recordServerStreamEvent = (userId: number, details: TStreamEventDetails): void => {
	try {
		const parsed = streamEventDetailsSchema.safeParse(details);
		if (!parsed.success) return;
		logger.info(
			'[stream-event] %s',
			JSON.stringify({
				...parsed.data,
				source: 'server',
				reporterUserId: userId,
				occurredAt: Date.now(),
			}),
		);
	} catch {
		/* Logging must not alter producer/consumer ownership. */
	}
};
