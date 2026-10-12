import { expect, test } from 'bun:test';
import type { telemetryHealth } from './health';
import { withErrorDeliveryHealth } from './sentry-delivery-health';

test('observes SDK drop/send/flush outcomes while preserving transport behavior', async () => {
	const counters: Parameters<typeof telemetryHealth.count>[0][] = [];
	let drops = 0;
	let outcome = 200;
	let reject = false;
	const error = new Error('network');
	const factory = withErrorDeliveryHealth(
		(options) => ({
			send: async () => {
				if (reject) {
					options.recordDroppedEvent('network_error', 'error');
					throw error;
				}
				return { statusCode: outcome };
			},
			flush: async (timeout) => timeout === 2000,
		}),
		{
			count: (reason) => {
				counters.push(reason);
			},
		},
	);
	const transport = factory({
		url: 'https://example.invalid',
		recordDroppedEvent: () => {
			drops++;
		},
	});
	expect(await transport.send([{}, []])).toEqual({ statusCode: 200 });
	expect(counters).toEqual([]);
	outcome = 429;
	expect(await transport.send([{}, []])).toEqual({ statusCode: 429 });
	reject = true;
	await expect(Promise.resolve(transport.send([{}, []]))).rejects.toBe(error);
	expect(drops).toBe(1);
	expect(await transport.flush(2000)).toBe(true);
	expect(await transport.flush(1)).toBe(false);
	expect(counters).toEqual([
		'error_export_failure',
		'error_transport_dropped',
		'error_export_failure',
		'error_flush_timeout',
	]);
});

test('a throwing health observer cannot reject successful export or change the original rejection', async () => {
	const error = new Error('original');
	const factory = withErrorDeliveryHealth(
		() => ({
			send: async () => {
				throw error;
			},
			flush: async () => false,
		}),
		{
			count: () => {
				throw new Error('health');
			},
		},
	);
	const transport = factory({ url: 'https://example.invalid', recordDroppedEvent: () => {} });
	await expect(Promise.resolve(transport.send([{}, []]))).rejects.toBe(error);
	expect(await transport.flush()).toBe(false);
});
