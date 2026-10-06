import { describe, expect, it } from 'bun:test';
import { shouldHandleVoiceTransportFailure } from '../voice-transport-failure-identity';

const current = {
	producerTransportId: 'producer-current',
	consumerTransportId: 'consumer-current',
};

describe('voice transport failure identity', () => {
	it('accepts identity-less events from older servers', () => {
		expect(shouldHandleVoiceTransportFailure({ userId: 1 }, current)).toBe(true);
	});

	it('rejects failures emitted for replaced transports', () => {
		expect(
			shouldHandleVoiceTransportFailure(
				{ userId: 1, source: 'media-liveness', transportId: 'consumer-replaced' },
				current,
			),
		).toBe(false);
		expect(
			shouldHandleVoiceTransportFailure(
				{ userId: 1, source: 'producer-dtls', transportId: 'producer-replaced' },
				current,
			),
		).toBe(false);
	});

	it('accepts failures matching the current transport side', () => {
		expect(
			shouldHandleVoiceTransportFailure(
				{ userId: 1, source: 'media-liveness', transportId: 'consumer-current' },
				current,
			),
		).toBe(true);
		expect(
			shouldHandleVoiceTransportFailure(
				{ userId: 1, source: 'producer-dtls', transportId: 'producer-current' },
				current,
			),
		).toBe(true);
	});
});
