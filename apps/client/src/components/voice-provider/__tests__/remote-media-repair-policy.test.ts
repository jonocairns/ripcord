import { describe, expect, it } from 'bun:test';
import { getRemoteMediaRepairDelayMs } from '../hooks/remote-media-repair-policy';

describe('remote media repair policy', () => {
	it('backs off three times and then exhausts the repair budget', () => {
		expect([0, 1, 2, 3].map(getRemoteMediaRepairDelayMs)).toEqual([15_000, 30_000, 60_000, undefined]);
	});
});
