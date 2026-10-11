import { describe, expect, test } from 'bun:test';
import {
	diagnosticBatchSchema,
	diagnosticRecordSchema,
	fitDiagnosticRecord,
	sanitizeDiagnosticRecord,
	type TDiagnosticRecord,
} from '../diagnostics';
import { sdkEventRecord } from '../parsed-error';

const record = (): TDiagnosticRecord => ({
	id: crypto.randomUUID(),
	sequence: 1,
	occurredAt: 1234,
	kind: 'exception',
	level: 'error',
	message: 'failed',
	runtime: 'desktop',
	release: '2.4.0',
	environment: 'production',
});
describe('diagnostic records', () => {
	test('scrubs both credentials and local paths without destroying correlation IDs or frame coordinates', () => {
		const operationId = crypto.randomUUID();
		const result = sanitizeDiagnosticRecord({
			...record(),
			message: 'Bearer secret test@example.com https://chat/?token=secret',
			context: { operationId, authorization: 'private', password: 'secret', value: 'token=private' },
			exception: {
				type: 'Error',
				message: 'failed',
				stack: 'at /home/alice/app.js',
				frames: [{ filename: 'https://alice:pass@server/assets/abc.js?token=private', lineno: 20, colno: 3 }],
			},
		});
		expect(JSON.stringify(result)).not.toContain('secret');
		expect(result.context?.operationId).toBe(operationId);
		expect(result.exception?.frames[0]).toEqual({
			filename: 'https://server/assets/abc.js',
			function: undefined,
			lineno: 20,
			colno: 3,
		});
		expect(result.exception?.stack).toBe('at ~/app.js');
	});
	test('rejects arbitrary envelopes, impersonation fields, oversized strings and aggregate payloads', () => {
		expect(diagnosticRecordSchema.safeParse({ ...record(), userId: 1 }).success).toBe(false);
		expect(diagnosticRecordSchema.safeParse({ ...record(), message: 'x'.repeat(1001) }).success).toBe(false);
		expect(
			diagnosticRecordSchema.safeParse({
				...record(),
				exception: {
					type: 'Error',
					message: 'x',
					frames: Array.from({ length: 40 }, () => ({ filename: 'x'.repeat(500) })),
				},
			}).success,
		).toBe(false);
		expect(
			diagnosticBatchSchema.safeParse({
				clientSessionId: crypto.randomUUID(),
				droppedEvents: 0,
				records: Array.from({ length: 9 }, record),
			}).success,
		).toBe(false);
	});
	test('preserves client timestamps, original stack, resource release, frames, debug IDs and trace context', () => {
		const debugId = crypto.randomUUID();
		const error = new Error('original');
		const result = sdkEventRecord(
			{
				timestamp: 1.234,
				release: '2.4.0',
				environment: 'production',
				contexts: {
					trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) },
					reported_error: { producerId: 'producer-1' },
				},
				debug_meta: { images: [{ type: 'sourcemap', code_file: 'https://server/assets/a.js', debug_id: debugId }] },
				exception: {
					values: [
						{
							type: 'TypeError',
							value: 'original',
							stacktrace: { frames: [{ filename: 'https://server/assets/a.js', lineno: 2, colno: 3 }] },
						},
					],
				},
			},
			{ originalException: error },
			'desktop',
		);
		expect(result.occurredAt).toBe(1234);
		expect(result.release).toBe('2.4.0');
		expect(result.traceId).toBe('a'.repeat(32));
		expect(result.exception?.stack).toBe(error.stack);
		expect(result.exception?.frames[0]?.debugId).toBe(debugId);
		expect(result.context?.producerId).toBe('producer-1');
	});
});

test('fits long parsed exceptions without losing identity or normal source-map frames', () => {
	const frames = Array.from({ length: 40 }, (_, i) => ({
		filename: 'https://server/assets/a.js',
		lineno: i,
		colno: 3,
	}));
	const input = {
		...record(),
		traceId: 'a'.repeat(32),
		exception: { type: 'TypeError', message: 'failure', stack: 's'.repeat(8000), frames },
		breadcrumbs: Array.from({ length: 30 }, () => ({ occurredAt: 1, message: 'b'.repeat(400) })),
		context: { operationId: crypto.randomUUID(), token: 'secret' },
	};
	expect(diagnosticRecordSchema.safeParse(input).success).toBe(false);
	const fitted = fitDiagnosticRecord(input);
	expect(diagnosticRecordSchema.safeParse(fitted).success).toBe(true);
	expect(fitted?.exception?.frames).toEqual(frames.map((f) => ({ ...f, function: undefined })));
	expect(fitted?.id).toBe(input.id);
	expect(fitted?.occurredAt).toBe(input.occurredAt);
	expect(fitted?.traceId).toBe(input.traceId);
	expect(fitted?.context?.operationId).toBe(input.context.operationId);
	expect(JSON.stringify(fitted)).not.toContain('secret');
	expect(input.breadcrumbs).toHaveLength(30);
	expect(fitDiagnosticRecord({ ...input, userId: 123 })).toBeUndefined();
});
