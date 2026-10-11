import { StreamKind } from './types';
import { z } from './zod';

// Versioned, deliberately closed vocabulary: never forward console arguments,
// exception messages, capture titles, SDP, URLs or transport network addresses.
export const streamEventNames = [
	'watch_requested',
	'watch_stopped',
	'watch_retry_requested',
	'watch_intent_retained',
	'watch_intent_cleared',
	'producer_closed_received',
	'consume_started',
	'consume_attempt',
	'consume_attempt_failed',
	'consume_retry',
	'consume_succeeded',
	'consumer_created',
	'consume_exhausted',
	'consume_cancelled',
	'consumer_closed',
	'consumer_resumed',
	'producer_publish_started',
	'producer_published',
	'producer_publish_failed',
	'producer_closed',
	'producer_replaced',
	'transport_created',
	'transport_closed',
	'playback_first_frame',
	'playback_stalled',
	'playback_recovered',
	'playback_inactive',
] as const;

export const streamEventReasons = [
	'manual',
	'recoverable_close',
	'terminal_close',
	'transport_cleanup',
	'transport_replaced',
	'producer_replaced',
	'consumer_replaced',
	'local_closed',
	'retry_exhausted',
	'publication_failed',
	'attempt_failed',
	'timeout',
	'cancelled',
	'no_incoming_media',
	'no_decoding',
	'no_playback',
	'static_or_idle',
] as const;

const boundedCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const mediaId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const streamEventDetailsSchema = z
	.object({
		event: z.enum(streamEventNames),
		kind: z.enum(StreamKind).optional(),
		channelId: z.number().int().positive().optional(),
		remoteId: z.number().int().positive().optional(),
		producerId: mediaId.optional(),
		previousProducerId: mediaId.optional(),
		consumerId: mediaId.optional(),
		transportId: mediaId.optional(),
		operationId: z.string().uuid().optional(),
		reconnectAttemptId: z.string().uuid().optional(),
		mode: z.enum(['automatic', 'manual']).optional(),
		reason: z.enum(streamEventReasons).optional(),
		attempt: z.number().int().min(1).max(100).optional(),
		desired: z.boolean().optional(),
		recoverable: z.boolean().optional(),
		bytesReceived: boundedCounter.optional(),
		framesReceived: boundedCounter.optional(),
		framesDecoded: boundedCounter.optional(),
		framesRendered: boundedCounter.optional(),
	})
	.strict();

export const clientStreamEventSchema = streamEventDetailsSchema
	.extend({
		occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
		sequence: boundedCounter,
	})
	.strict();

export const streamEventBatchSchema = z
	.object({
		clientSessionId: z.string().uuid(),
		clientVersion: z.string().regex(/^[a-zA-Z0-9.+_-]{1,64}$/),
		droppedEvents: boundedCounter,
		events: z.array(clientStreamEventSchema).min(1).max(32),
	})
	.strict();

export type TStreamEventDetails = z.infer<typeof streamEventDetailsSchema>;
export type TClientStreamEvent = z.infer<typeof clientStreamEventSchema>;
export type TStreamEventBatch = z.infer<typeof streamEventBatchSchema>;
