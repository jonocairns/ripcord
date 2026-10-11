import { describe, expect, it } from 'bun:test';
import { StreamKind, type TStreamEventDetails } from '@sharkord/shared';
import { createStreamFailureReporter } from '../stream-failure-reporting';

describe('screen consume Sentry budget', () => {
	it('reports only exhaustion, with per-producer cooldown and session window cap', () => {
		const sent: TStreamEventDetails[] = [];
		let now = 0;
		const report = createStreamFailureReporter(
			(event) => {
				sent.push(event);
			},
			() => now,
		);
		const event: TStreamEventDetails = {
			event: 'consume_exhausted',
			reason: 'retry_exhausted',
			kind: StreamKind.SCREEN,
			remoteId: 1,
			producerId: 'p1',
		};
		report({ ...event, event: 'consume_retry' });
		report({ ...event, reason: 'publication_failed' });
		report(event);
		report({ ...event, operationId: crypto.randomUUID() });
		report({ ...event, producerId: 'p2' });
		report({ ...event, producerId: 'p3' });
		report({ ...event, producerId: 'p4' });
		expect(sent.length).toBe(3);
		now = 600_001;
		report(event);
		expect(sent.length).toBe(4);
	});
});
