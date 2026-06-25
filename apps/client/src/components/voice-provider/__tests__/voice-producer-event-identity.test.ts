import { describe, expect, it } from 'bun:test';
import { shouldIgnoreProducerClosedEvent } from '../hooks/voice-producer-event-identity';

describe('voice producer event identity', () => {
	it('keeps legacy close events without a producer id', () => {
		expect(
			shouldIgnoreProducerClosedEvent({
				activeConsumerProducerId: 'current-producer',
				eventProducerId: undefined,
			}),
		).toBe(false);
	});

	it('ignores close events for a replaced active consumer producer', () => {
		expect(
			shouldIgnoreProducerClosedEvent({
				activeConsumerProducerId: 'current-producer',
				eventProducerId: 'old-producer',
			}),
		).toBe(true);
	});

	it('ignores close events for a replaced pending producer', () => {
		expect(
			shouldIgnoreProducerClosedEvent({
				eventProducerId: 'old-producer',
				pendingProducerId: 'current-producer',
			}),
		).toBe(true);
	});

	it('accepts close events for matching producer ids', () => {
		expect(
			shouldIgnoreProducerClosedEvent({
				activeConsumerProducerId: 'producer-1',
				eventProducerId: 'producer-1',
				pendingProducerId: 'producer-1',
			}),
		).toBe(false);
	});
});
