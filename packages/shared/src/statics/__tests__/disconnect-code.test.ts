import { describe, expect, test } from 'bun:test';
import { DisconnectCode } from '..';

describe('DisconnectCode', () => {
	test.each([
		DisconnectCode.KICKED,
		DisconnectCode.BANNED,
		DisconnectCode.SERVER_SHUTDOWN,
	])('application close code %i is valid for a WebSocket close frame', (code) => {
		expect(code).toBeGreaterThanOrEqual(3_000);
		expect(code).toBeLessThanOrEqual(4_999);
	});
});
