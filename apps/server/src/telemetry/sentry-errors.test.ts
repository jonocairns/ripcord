import { expect, test } from 'bun:test';
import type { TDiagnosticRecord } from '@sharkord/shared';
import { createSentryErrorAdapter } from './sentry-errors';

test('actual SDK export retains client release, stack frames, source maps and trace identity', async () => {
	const envelopes: unknown[] = [];
	const adapter = createSentryErrorAdapter('https://public@sentry.invalid/1', () => ({
		send: async (envelope) => {
			envelopes.push(envelope);
			return { statusCode: 200 };
		},
		flush: async () => true,
	}));
	const debugId = crypto.randomUUID();
	const eventId = crypto.randomUUID();
	const record: TDiagnosticRecord = {
		id: eventId,
		sequence: 1,
		occurredAt: 1234,
		kind: 'exception',
		level: 'error',
		message: 'client failed',
		runtime: 'desktop',
		release: '2.4.0',
		environment: 'production',
		traceId: 'a'.repeat(32),
		spanId: 'b'.repeat(16),
		exception: {
			type: 'TypeError',
			message: 'client failed',
			frames: [{ filename: 'https://server/assets/a.js', lineno: 5, colno: 9, debugId }],
		},
	};
	adapter.forward(record, 7, 'session');
	await adapter.flush();
	const json = JSON.stringify(envelopes);
	expect(json).toContain('"timestamp":1.234');
	expect(json).toContain('"release":"2.4.0"');
	expect(json).toContain('"platform":"javascript"');
	expect(json).toContain('"runtime":"desktop"');
	expect(json).toContain('"source":"client"');
	expect(json).toContain(`"trace_id":"${'a'.repeat(32)}"`);
	expect(json).toContain(debugId);
	expect(json).toContain('"lineno":5');
	expect(json).not.toContain('sentry-errors.ts');
	expect(json).toContain(eventId.replaceAll('-', ''));
	const disabled = createSentryErrorAdapter('');
	disabled.forward(record, 7, 'session');
	await disabled.flush();
	expect(envelopes).toHaveLength(1);
});
