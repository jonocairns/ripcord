import { expect, test } from 'bun:test';
import { clientTraceBatchSchema, sanitizeClientTraceBatch, type TClientTraceBatch, traceEnvelopeSchema } from '../otlp';

const batch = (): TClientTraceBatch => ({
	resourceSpans: [
		{
			resource: {
				attributes: [
					{ key: 'service.name', value: { stringValue: 'forged-server' } },
					{ key: 'email', value: { stringValue: 'private@example.com' } },
				],
				droppedAttributesCount: 0,
			},
			scopeSpans: [
				{
					scope: { name: 'ripcord.client' },
					spans: [
						{
							traceId: 'a'.repeat(32),
							spanId: 'b'.repeat(16),
							parentSpanId: 'c'.repeat(16),
							traceState: 'vendor=value',
							name: 'voice.restore',
							kind: 1,
							startTimeUnixNano: '1000000',
							endTimeUnixNano: '2000000',
							attributes: [{ key: 'token', value: { stringValue: 'secret' } }],
							droppedAttributesCount: 0,
							events: [],
							droppedEventsCount: 0,
							links: [],
							droppedLinksCount: 0,
							status: { code: 1 },
							flags: 257,
						},
					],
				},
			],
		},
	],
});
test('OTLP validation and scrub preserve span graph, time and sampling with authoritative client identity', () => {
	const input = batch();
	const result = sanitizeClientTraceBatch(clientTraceBatchSchema.parse(input), 123);
	expect(JSON.stringify(result)).not.toContain('secret');
	expect(JSON.stringify(result)).not.toContain('private@example.com');
	expect(result.resourceSpans[0]?.resource.attributes).toContainEqual({
		key: 'service.name',
		value: { stringValue: 'ripcord.client' },
	});
	expect(result.resourceSpans[0]?.resource.attributes).toContainEqual({
		key: 'ripcord.reporter_user.id',
		value: { intValue: '123' },
	});
	expect(result.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toMatchObject({
		traceId: 'a'.repeat(32),
		spanId: 'b'.repeat(16),
		parentSpanId: 'c'.repeat(16),
		startTimeUnixNano: '1000000',
		endTimeUnixNano: '2000000',
		traceState: 'vendor=value',
		flags: 257,
	});
	expect(clientTraceBatchSchema.safeParse({ ...input, envelope: 'forbidden' }).success).toBe(false);
	const span = input.resourceSpans[0]?.scopeSpans[0]?.spans[0];
	if (!span) throw Error('fixture');
	span.traceId = '0'.repeat(32);
	expect(clientTraceBatchSchema.safeParse(input).success).toBe(false);
	expect(
		traceEnvelopeSchema.safeParse({
			__ripcordTrace: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
			input: { channelId: 1 },
		}).success,
	).toBe(true);
	expect(
		traceEnvelopeSchema.safeParse({ __ripcordTrace: { traceparent: `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01` } })
			.success,
	).toBe(false);
});

test('W3C envelope round-trips bounded trace state while rejecting oversized or unexpected carrier fields', () => {
	const carrier = { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, tracestate: 'vendor=value' };
	expect(traceEnvelopeSchema.parse({ __ripcordTrace: carrier, input: { channelId: 1 } })).toEqual({
		__ripcordTrace: carrier,
		input: { channelId: 1 },
	});
	expect(traceEnvelopeSchema.safeParse({ __ripcordTrace: { ...carrier, tracestate: 'x'.repeat(513) } }).success).toBe(
		false,
	);
	expect(
		traceEnvelopeSchema.safeParse({ __ripcordTrace: { ...carrier, authorization: 'Bearer secret' } }).success,
	).toBe(false);
});
