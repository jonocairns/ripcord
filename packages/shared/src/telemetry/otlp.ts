import { z } from '../zod';
import { sanitizeDiagnosticText } from './diagnostics';

const counter = z.number().int().min(0).max(10000);
const traceId = z.string().regex(/^(?!0+$)[a-f0-9]{32}$/);
const spanId = z.string().regex(/^(?!0+$)[a-f0-9]{16}$/);
const nano = z
	.string()
	.regex(/^\d{1,20}$/)
	.refine((v) => BigInt(v) <= 8_640_000_000_000_000_000_000n);
const value = z.union([
	z.object({ stringValue: z.string().max(200) }).strict(),
	z.object({ boolValue: z.boolean() }).strict(),
	z.object({ intValue: z.union([z.string().regex(/^-?\d{1,16}$/), z.number().int().finite()]) }).strict(),
	z.object({ doubleValue: z.number().finite() }).strict(),
]);
const attribute = z.object({ key: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), value }).strict();
const span = z
	.object({
		traceId,
		spanId,
		parentSpanId: spanId.optional(),
		traceState: z.string().max(512).optional(),
		name: z.string().max(200),
		kind: z.number().int().min(0).max(5),
		startTimeUnixNano: nano,
		endTimeUnixNano: nano,
		attributes: z.array(attribute).max(32),
		droppedAttributesCount: counter,
		events: z.array(z.never()).max(0),
		droppedEventsCount: counter,
		links: z.array(z.never()).max(0),
		droppedLinksCount: counter,
		status: z.object({ code: z.number().int().min(0).max(2), message: z.string().max(200).optional() }).strict(),
		flags: z.number().int().min(0).max(1023),
	})
	.strict()
	.refine(
		(s) =>
			BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano) &&
			BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano) <= 600_000_000_000n,
		'Invalid span duration',
	);
export const clientTraceBatchSchema = z
	.object({
		resourceSpans: z
			.array(
				z
					.object({
						resource: z.object({ attributes: z.array(attribute).max(16), droppedAttributesCount: counter }).strict(),
						scopeSpans: z
							.array(
								z
									.object({
										scope: z
											.object({ name: z.literal('ripcord.client'), version: z.string().max(64).optional() })
											.strict(),
										spans: z.array(span).min(1).max(16),
										schemaUrl: z.string().max(200).optional(),
									})
									.strict(),
							)
							.min(1)
							.max(2),
						schemaUrl: z.string().max(200).optional(),
					})
					.strict(),
			)
			.min(1)
			.max(2),
	})
	.strict()
	.refine(
		(v) =>
			v.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)).length <= 16 &&
			new TextEncoder().encode(JSON.stringify(v)).length <= 64_000,
		'Trace batch too large',
	);
export type TClientTraceBatch = z.infer<typeof clientTraceBatchSchema>;
const sanitizeAttributes = (attributes: z.infer<typeof attribute>[]) =>
	attributes.map((a) => ({
		...a,
		value: /(?:authorization|cookie|token|secret|password|passwd|dsn|email|^ip$)/i.test(a.key)
			? { stringValue: '[redacted]' }
			: 'stringValue' in a.value
				? { stringValue: sanitizeDiagnosticText(a.value.stringValue) }
				: a.value,
	}));
// Preserve IDs, parents, time, flags and scope. The relay adds authenticated identity
// to the client resource; it never creates replacement server spans.
export const sanitizeClientTraceBatch = (batch: TClientTraceBatch, userId: number): TClientTraceBatch => ({
	resourceSpans: batch.resourceSpans.map((r) => ({
		...r,
		resource: {
			...r.resource,
			attributes: [
				...sanitizeAttributes(
					r.resource.attributes
						.slice(0, 13)
						.filter((a) => !['service.name', 'ripcord.reporter_user.id', 'ripcord.source'].includes(a.key)),
				),
				{ key: 'service.name', value: { stringValue: 'ripcord.client' } },
				{ key: 'ripcord.source', value: { stringValue: 'client' } },
				{ key: 'ripcord.reporter_user.id', value: { intValue: String(userId) } },
			],
		},
		scopeSpans: r.scopeSpans.map((s) => ({
			...s,
			spans: s.spans.map((span) => ({
				...span,
				name: sanitizeDiagnosticText(span.name),
				attributes: sanitizeAttributes(span.attributes),
				status: {
					...span.status,
					message: span.status.message ? sanitizeDiagnosticText(span.status.message) : undefined,
				},
			})),
		})),
	})),
});
export const traceCarrierSchema = z
	.object({ traceparent: z.string().regex(/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/) })
	.strict();
export const traceEnvelopeSchema = z
	.object({ __ripcordTrace: traceCarrierSchema, input: z.unknown().optional() })
	.strict();
