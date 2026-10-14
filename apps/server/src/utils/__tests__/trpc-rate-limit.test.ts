import { afterEach, expect, spyOn, test } from 'bun:test';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { logger } from '../../logger';
import { publicProcedure, rateLimitedProcedure, t } from '../trpc';

let restoreSpies: (() => void) | undefined;
afterEach(() => {
	restoreSpies?.();
	restoreSpies = undefined;
});

test('rate-limit rejections warn once per window and count the suppressed ones', async () => {
	let clock = 1_000;
	const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
	const now = spyOn(performance, 'now').mockImplementation(() => clock);
	restoreSpies = () => {
		warn.mockRestore();
		now.mockRestore();
	};
	const ping = rateLimitedProcedure(publicProcedure, { maxRequests: 1, windowMs: 60_000, logLabel: 'test.ping' });
	const caller = t
		.router({ ping: ping.mutation(() => 'pong') })
		.createCaller(await createMockContext({ customToken: await getMockedToken(1) }));

	expect(await caller.ping()).toBe('pong');
	for (let index = 0; index < 3; index += 1) {
		await expect(caller.ping()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
	}
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn).toHaveBeenNthCalledWith(1, expect.any(String), 'test.ping', 'user:1', 0);

	clock += 60_000;
	expect(await caller.ping()).toBe('pong');
	await expect(caller.ping()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
	expect(warn).toHaveBeenCalledTimes(2);
	expect(warn).toHaveBeenNthCalledWith(2, expect.any(String), 'test.ping', 'user:1', 2);
});
