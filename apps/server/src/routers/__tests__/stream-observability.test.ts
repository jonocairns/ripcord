import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { StreamKind, type TStreamEventBatch } from '@sharkord/shared';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { logger } from '../../logger';
import { appRouter } from '../../routers';

const batch = (): TStreamEventBatch => ({
	clientSessionId: crypto.randomUUID(),
	clientVersion: '2.4.0',
	droppedEvents: 0,
	events: [
		{
			event: 'consume_succeeded',
			kind: StreamKind.SCREEN,
			remoteId: 2,
			producerId: 'producer-2',
			occurredAt: 100,
			sequence: 1,
		},
	],
});
const authenticated = async () => {
	const ctx = await createMockContext({ customToken: await getMockedToken(1) });
	const caller = appRouter.createCaller(ctx);
	const { handshakeHash } = await caller.others.handshake();
	const join = await caller.others.joinServer({ handshakeHash });
	return { ctx, caller, join };
};
let restoreLogger: (() => void) | undefined;
afterEach(() => {
	restoreLogger?.();
	restoreLogger = undefined;
});

describe('authenticated stream diagnostics ingestion', () => {
	test('advertises implemented support and derives reporter identity from auth', async () => {
		const { ctx, caller, join } = await authenticated();
		expect(join).toHaveProperty('streamObservabilityVersion', 1);
		const messages: unknown[][] = [];
		const log = spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
			messages.push(args);
			return logger;
		});
		restoreLogger = () => log.mockRestore();
		await caller.voice.reportStreamEvents(batch());
		expect(messages[0]?.[0]).toMatchObject({
			message: '[stream-event]',
			reporterUserId: ctx.user.id,
			source: 'client',
			remoteId: 2,
			occurredAt: 100,
		});
		expect(JSON.stringify(messages)).not.toContain(ctx.token);
	});
	test('rejects unauthenticated callers, forged actors, arbitrary content and oversized batches', async () => {
		const { ctx, caller } = await authenticated();
		ctx.authenticated = false;
		await expect(caller.voice.reportStreamEvents(batch())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
		ctx.authenticated = true;
		const log = spyOn(logger, 'info').mockImplementation(() => logger);
		restoreLogger = () => log.mockRestore();
		await expect(caller.voice.reportStreamEvents(Object.assign(batch(), { reporterUserId: 2 }))).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		});
		const payload = batch();
		const event = payload.events[0];
		if (!event) throw new Error('missing fixture event');
		await expect(
			caller.voice.reportStreamEvents({
				...payload,
				events: [{ ...event, producerId: 'https://private/?token=secret' }],
			}),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(
			caller.voice.reportStreamEvents({
				...payload,
				events: [Object.assign({ ...event }, { message: 'private title' })],
			}),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(
			caller.voice.reportStreamEvents({ ...payload, events: Array.from({ length: 33 }, () => event) }),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		expect(log).not.toHaveBeenCalled();
	});
	test('limits per authenticated user even if the client changes session IDs', async () => {
		const { caller } = await authenticated();
		const log = spyOn(logger, 'info').mockImplementation(() => logger);
		restoreLogger = () => log.mockRestore();
		let limited = false;
		for (let index = 0; index < 31; index += 1) {
			try {
				await caller.voice.reportStreamEvents(batch());
			} catch (error) {
				expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
				limited = true;
				break;
			}
		}
		expect(limited).toBe(true);
	});
});
