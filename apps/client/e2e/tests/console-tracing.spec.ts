import { expect, test } from '@playwright/test';
import { createPeer, credentialsFor, disposePeer, dropAppWebSocket, joinVoice } from '../helpers/app';
import { readServerLog } from '../helpers/server-log';

const readRecords = async (): Promise<Record<string, unknown>[]> =>
	(await readServerLog()).split('\n').flatMap((line) => {
		try {
			const value: unknown = JSON.parse(line);
			return value && typeof value === 'object' && !Array.isArray(value)
				? [Object.fromEntries(Object.entries(value))]
				: [];
		} catch {
			return [];
		}
	});

test('voice recovery uploads useful state and command outcomes without private payloads', async ({
	browser,
}, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));
	const marker = crypto.randomUUID();
	const findProbe = async () =>
		(await readRecords()).find(
			(record) =>
				record.context && typeof record.context === 'object' && Reflect.get(record.context, 'operationId') === marker,
		);
	try {
		await joinVoice(peer.page);
		await peer.page.evaluate(async (marker) => {
			const path = '/src/helpers/browser-logger.ts';
			const logger: unknown = await import(path);
			if (!logger || typeof logger !== 'object' || !('logVoice' in logger) || typeof logger.logVoice !== 'function')
				throw new Error('Voice logger unavailable');
			logger.logVoice('Producer transport connection state changed', 'private-extra-argument', {
				operationId: marker,
				state: 'disconnected',
				attempt: 2,
				micMuted: true,
				durationMs: 25,
				deviceLabel: 'private-device-label',
				sdp: 'private-sdp-payload',
				reason: 'private arbitrary reason',
				error: new TypeError('private-error-message'),
			});
		}, marker);
		await dropAppWebSocket(peer.page);
		await expect.poll(findProbe).toMatchObject({
			message: 'Producer transport connection state changed',
			context: { state: 'disconnected', attempt: 2, micMuted: true, durationMs: 25, errorType: 'TypeError' },
		});
		await expect
			.poll(
				async () =>
					(await readRecords()).filter((r) => r.message === 'Voice session command finished' && r.source === 'client')
						.length,
			)
			.toBeGreaterThan(0);
		await expect
			.poll(
				async () =>
					(await readRecords()).filter((r) => r.message === 'Voice WebSocket closed' && r.source === 'client').length,
			)
			.toBeGreaterThan(0);
		const probe = await findProbe();
		const output = JSON.stringify(probe);
		for (const value of [
			'private-extra-argument',
			'private-device-label',
			'private-sdp-payload',
			'private arbitrary reason',
			'private-error-message',
		])
			expect(output).not.toContain(value);
	} finally {
		await disposePeer(peer);
	}
});

test('local trace output follows opt-in configuration and preserves the client/server span graph', async ({
	browser,
}, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));
	const operationId = crypto.randomUUID();
	const enabled = process.env.RIPCORD_TRACING_CONSOLE_ENABLED === 'true';
	try {
		await peer.page.evaluate(async (operationId) => {
			const tracingPath = '/src/helpers/telemetry/tracing.ts';
			const backendPath = '/src/helpers/telemetry/backend.ts';
			const rpcPath = '/src/lib/trpc.ts';
			const tracing: unknown = await import(tracingPath);
			const backend: unknown = await import(backendPath);
			const rpc: unknown = await import(rpcPath);
			if (
				!tracing ||
				typeof tracing !== 'object' ||
				!('startSpanObservation' in tracing) ||
				typeof tracing.startSpanObservation !== 'function' ||
				!backend ||
				typeof backend !== 'object' ||
				!('flushClientTracing' in backend) ||
				typeof backend.flushClientTracing !== 'function' ||
				!rpc ||
				typeof rpc !== 'object' ||
				!('getTRPCClient' in rpc) ||
				typeof rpc.getTRPCClient !== 'function'
			)
				throw new Error('Tracing modules unavailable');
			const observation = tracing.startSpanObservation({
				name: 'e2e.console_trace',
				attributes: { operationId, password: 'private-trace-secret', email: 'private@example.com' },
			});
			const client = rpc.getTRPCClient();
			await observation.run(() => client.others.handshake.query());
			observation.finish({ status: 'ok' });
			await backend.flushClientTracing();
		}, operationId);
		if (!enabled) {
			await expect.poll(async () => (await readRecords()).filter((r) => r.kind === 'trace')).toHaveLength(0);
			return;
		}
		await expect
			.poll(async () =>
				(await readRecords()).find(
					(r) =>
						r.spanName === 'e2e.console_trace' &&
						r.attributes &&
						typeof r.attributes === 'object' &&
						Reflect.get(r.attributes, 'operationId') === operationId,
				),
			)
			.toMatchObject({
				kind: 'trace',
				source: 'client',
				level: process.env.RIPCORD_TRACING_CONSOLE_LEVEL ?? 'info',
				status: 'ok',
			});
		const records = await readRecords();
		const parent = records.find(
			(r) =>
				r.spanName === 'e2e.console_trace' &&
				r.attributes &&
				typeof r.attributes === 'object' &&
				Reflect.get(r.attributes, 'operationId') === operationId,
		);
		if (!parent) throw new Error('Missing client parent');
		await expect
			.poll(async () => {
				const current = await readRecords();
				const child = current.find(
					(r) => r.source === 'client' && r.parentSpanId === parent.spanId && r.spanName === 'rpc.others.handshake',
				);
				return (
					child &&
					current.find((r) => r.source === 'server' && r.parentSpanId === child.spanId && r.traceId === parent.traceId)
				);
			})
			.toMatchObject({ kind: 'trace', spanName: 'rpc.others.handshake', source: 'server' });
		expect(JSON.stringify(records.filter((r) => r.kind === 'trace'))).not.toContain('private-trace-secret');
		expect(JSON.stringify(records.filter((r) => r.kind === 'trace'))).not.toContain('private@example.com');
	} finally {
		await disposePeer(peer);
	}
});
