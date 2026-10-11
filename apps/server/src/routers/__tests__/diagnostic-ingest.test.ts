import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { TDiagnosticBatch } from '@sharkord/shared';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { logger } from '../../logger';
import { appRouter } from '../../routers';
import { diagnosticIngest } from '../../telemetry/diagnostics';

const batch = (): TDiagnosticBatch => ({
	clientSessionId: crypto.randomUUID(),
	droppedEvents: 0,
	records: [
		{
			id: crypto.randomUUID(),
			sequence: 1,
			occurredAt: Date.now(),
			kind: 'exception',
			level: 'error',
			message: 'failed',
			runtime: 'web',
			release: '2.4.0',
			environment: 'test',
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

describe('authenticated diagnostic ingestion', () => {
	test('advertises authenticated support and allows accepted uploads', async () => {
		const { caller, join } = await authenticated();
		expect(join).toHaveProperty('diagnosticsVersion', 1);
		await caller.telemetry.reportDiagnostics(batch());
		diagnosticIngest.flush();
	});
	test('rejects unauthenticated callers, forged actors, arbitrary content and oversized batches', async () => {
		const { ctx, caller } = await authenticated();
		ctx.authenticated = false;
		await expect(caller.telemetry.reportDiagnostics(batch())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
		ctx.authenticated = true;
		ctx.user.mustChangePassword = true;
		await expect(caller.telemetry.reportDiagnostics(batch())).rejects.toMatchObject({ code: 'FORBIDDEN' });
		ctx.user.mustChangePassword = false;
		const log = spyOn(logger, 'info').mockImplementation(() => logger);
		restoreLogger = () => log.mockRestore();
		await expect(
			caller.telemetry.reportDiagnostics(Object.assign(batch(), { reporterUserId: 2 })),
		).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		});
		const payload = batch();
		const event = payload.records[0];
		if (!event) throw new Error('missing fixture event');
		await expect(
			caller.telemetry.reportDiagnostics({
				...payload,
				records: [{ ...event, message: 'x'.repeat(1001) }],
			}),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(
			caller.telemetry.reportDiagnostics({
				...payload,
				records: [Object.assign({ ...event }, { envelope: 'private' })],
			}),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(
			caller.telemetry.reportDiagnostics({ ...payload, records: Array.from({ length: 9 }, () => event) }),
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
				await caller.telemetry.reportDiagnostics(batch());
			} catch (error) {
				expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
				limited = true;
				break;
			}
		}
		expect(limited).toBe(true);
	});
});
