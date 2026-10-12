import { expect, test } from 'bun:test';
import { flushErrorReplay } from '../error-reporting/replay';

test('routed errors preserve opt-in buffered replay sampling and isolate upload failures', async () => {
	let calls = 0;
	const replay = {
		getRecordingMode: () => 'buffer',
		flush: async () => {
			calls++;
			throw new Error('provider offline');
		},
	};
	flushErrorReplay(replay, 0, () => 0);
	flushErrorReplay(replay, 0.2, () => 0.3);
	expect(calls).toBe(0);
	flushErrorReplay(replay, 0.2, () => 0.1);
	await Promise.resolve();
	expect(calls).toBe(1);
	flushErrorReplay({ ...replay, getRecordingMode: () => 'session' }, 1);
	expect(calls).toBe(1);
	expect(() =>
		flushErrorReplay(
			{
				...replay,
				getRecordingMode: () => {
					throw new Error('SDK');
				},
			},
			1,
		),
	).not.toThrow();
});
