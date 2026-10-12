import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as otel from '@sharkord/shared/telemetry/opentelemetry';
import type { TSpanObservation } from '@sharkord/shared/telemetry/tracing';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { consumeErrorTraceContext } from '../../helpers/error-trace-context';
import * as tracing from '../../helpers/tracing';
import { publicProcedure, t } from '../trpc';

let restoreTracing: (() => void) | undefined;
afterEach(() => {
	restoreTracing?.();
	restoreTracing = undefined;
});

const observeMiddleware = () => {
	const finish = mock((_options: Parameters<TSpanObservation['finish']>[0]) => {});
	const resolvedResults: boolean[] = [];
	const start = spyOn(tracing, 'startSpanObservation').mockImplementation(() => ({
		run: (effect) => {
			const result = effect();
			void Promise.resolve(result).then((value) => {
				if (typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean') {
					resolvedResults.push(value.ok);
				}
			});
			return result;
		},
		finish,
	}));
	restoreTracing = () => start.mockRestore();
	return { finish, start, resolvedResults };
};

describe('application RPC tracing middleware', () => {
	test('returns successful handler data and finishes one successful span', async () => {
		const { start, finish, resolvedResults } = observeMiddleware();
		const data = { restored: true };
		const handler = mock(() => data);
		const caller = t
			.router({ restore: publicProcedure.mutation(handler) })
			.createCaller(await createMockContext({ customToken: await getMockedToken(1) }));
		expect(await caller.restore()).toBe(data);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(resolvedResults).toEqual([true]);
		expect(start).toHaveBeenCalledWith({
			name: 'rpc.restore',
			op: 'rpc.server',
			attributes: { 'rpc.method': 'restore', 'rpc.type': 'mutation' },
		});
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith({ status: 'ok' });
	});

	test('marks a resolved unsuccessful result as failed and preserves its RPC error', async () => {
		const { finish, resolvedResults } = observeMiddleware();
		const original = new TRPCError({ code: 'CONFLICT', message: 'Session already owned' });
		const handler = mock(() => {
			throw original;
		});
		const caller = t
			.router({ restore: publicProcedure.mutation(handler) })
			.createCaller(await createMockContext({ customToken: await getMockedToken(1) }));
		await expect(caller.restore()).rejects.toBe(original);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(resolvedResults).toEqual([false]);
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith({ status: 'error' });
	});

	test('retains the original unexpected handler failure as the RPC error cause', async () => {
		const { finish, resolvedResults } = observeMiddleware();
		const original = new Error('transport allocation failed');
		const handler = mock(() => {
			throw original;
		});
		const caller = t
			.router({ restore: publicProcedure.mutation(handler) })
			.createCaller(await createMockContext({ customToken: await getMockedToken(1) }));
		const result = await caller.restore().catch((error: unknown) => error);
		expect(result).toBeInstanceOf(TRPCError);
		if (!(result instanceof TRPCError)) throw new Error('Expected the handler failure to reach the caller');
		expect(result.cause).toBe(original);
		expect(result.message).toBe(original.message);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(resolvedResults).toEqual([false]);
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith({ status: 'error' });
	});

	test('disabled tracing uses the no-op observation and preserves success and failure', async () => {
		tracing.configureServerTracing(false);
		const originalStart = tracing.startSpanObservation;
		const disabled = originalStart({ name: 'disabled' });
		const observations: TSpanObservation[] = [];
		const start = spyOn(tracing, 'startSpanObservation').mockImplementation((options) => {
			const observation = originalStart(options);
			observations.push(observation);
			return observation;
		});
		restoreTracing = () => start.mockRestore();
		const success = { restored: true };
		const original = new TRPCError({ code: 'CONFLICT' });
		const succeed = mock(() => success);
		const fail = mock(() => {
			throw original;
		});
		const caller = t
			.router({ succeed: publicProcedure.mutation(succeed), fail: publicProcedure.mutation(fail) })
			.createCaller(await createMockContext({ customToken: await getMockedToken(1) }));
		expect(await caller.succeed()).toBe(success);
		await expect(caller.fail()).rejects.toBe(original);
		expect(succeed).toHaveBeenCalledTimes(1);
		expect(fail).toHaveBeenCalledTimes(1);
		expect(observations).toEqual([disabled, disabled]);
	});
});

test('trace carrier unwrapping preserves handler validation and old-client inputs', async () => {
	const ctx = await createMockContext({ customToken: await getMockedToken(1) });
	const caller = t
		.router({ echo: publicProcedure.input(z.object({ channelId: z.number() })).mutation(({ input }) => input) })
		.createCaller(ctx);
	expect(await caller.echo({ channelId: 42 })).toEqual({ channelId: 42 });
	const envelope = {
		__ripcordTrace: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, tracestate: 'vendor=value' },
		input: { channelId: 43 },
	};
	// Internal caller's static input is the app schema; transport envelopes precede that schema.
	const call: unknown = Reflect.get(caller, 'echo');
	if (typeof call !== 'function') throw Error('Missing fixture procedure');
	expect(await call(envelope)).toEqual({ channelId: 43 });
	await expect(call({ ...envelope, input: { channelId: 'wrong' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
	await expect(call({ ...envelope, __ripcordTrace: { traceparent: 'invalid' } })).rejects.toMatchObject({
		code: 'BAD_REQUEST',
	});
});

test('production middleware saves the failing RPC context inside its observation scope', async () => {
	let inside = false;
	const ids = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
	const active = spyOn(otel, 'getActiveTraceContext').mockImplementation(() => (inside ? ids : {}));
	const start = spyOn(tracing, 'startSpanObservation').mockImplementation(() => ({
		run: (effect) => {
			inside = true;
			const value = effect();
			void Promise.resolve(value).then(
				() => {
					inside = false;
				},
				() => {
					inside = false;
				},
			);
			return value;
		},
		finish: () => {},
	}));
	try {
		const caller = t
			.router({
				fail: publicProcedure.query(() => {
					throw new Error('failed');
				}),
			})
			.createCaller(await createMockContext({ customToken: await getMockedToken(1) }));
		const error: unknown = await caller.fail().catch((error: unknown) => error);
		if (!(error instanceof TRPCError)) throw Error('Expected original RPC failure');
		expect(inside).toBe(false);
		expect(consumeErrorTraceContext(error)).toEqual(ids);
		expect(consumeErrorTraceContext(error)).toBeUndefined();
	} finally {
		active.mockRestore();
		start.mockRestore();
	}
});
