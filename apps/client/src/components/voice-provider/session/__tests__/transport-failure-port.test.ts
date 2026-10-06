import { describe, expect, it, mock } from 'bun:test';
import { createTransportFailurePort } from '../transport-failure-port';

describe('transport failure port', () => {
	it('drops reports while unbound and forwards them while bound', () => {
		const port = createTransportFailurePort();
		const handle = mock(() => {});
		port.report();
		const release = port.bind(handle);
		const failure = { userId: 1, source: 'producer-dtls' as const, transportId: 'producer-1' };
		port.report(failure);
		release();
		port.report();
		expect(handle).toHaveBeenCalledTimes(1);
		expect(handle).toHaveBeenCalledWith(failure);
	});

	it('does not let a replayed cleanup release the same handler bound again', () => {
		const port = createTransportFailurePort();
		const handle = mock(() => {});
		const replayedRelease = port.bind(handle);
		replayedRelease();
		const release = port.bind(handle);
		replayedRelease();
		port.report();
		expect(handle).toHaveBeenCalledTimes(1);
		release();
	});
});
