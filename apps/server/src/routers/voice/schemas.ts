import type { DtlsParameters, RtpCapabilities, RtpParameters, SrtpParameters } from 'mediasoup/types';
import { z } from 'zod';

// mediasoup payloads (rtpParameters, rtpCapabilities, dtlsParameters) are
// large, codec-specific structures that evolve across mediasoup versions.
// Modelling them field-by-field here would risk rejecting valid payloads from
// a newer mediasoup-client, so we only assert "is a plain object" at the tRPC
// edge and let mediasoup perform the authoritative validation (it throws a
// clean error on malformed input). z.custom passes the value through untouched
// (mediasoup reads every key) while still rejecting obviously-bogus
// primitives/arrays/null before they reach the native worker, and preserves
// the precise mediasoup type for the route handler.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const rtpParametersSchema = z.custom<RtpParameters>(isPlainObject, {
	message: 'Invalid rtpParameters',
});

const rtpCapabilitiesSchema = z.custom<RtpCapabilities>(isPlainObject, {
	message: 'Invalid rtpCapabilities',
});

const dtlsParametersSchema = z.custom<DtlsParameters>(isPlainObject, {
	message: 'Invalid dtlsParameters',
});

// SRTP keying material exchanged for the PlainTransport app-audio ingest. Unlike
// the opaque mediasoup payloads above this is a tiny, fully-known shape, so it is
// modelled explicitly. mediasoup performs the authoritative crypto-suite/key
// validation when connect() is called.
const srtpParametersSchema = z.object({
	cryptoSuite: z.enum(['AEAD_AES_256_GCM', 'AEAD_AES_128_GCM', 'AES_CM_128_HMAC_SHA1_80', 'AES_CM_128_HMAC_SHA1_32']),
	keyBase64: z.string().min(1),
}) satisfies z.ZodType<SrtpParameters>;

export { dtlsParametersSchema, rtpCapabilitiesSchema, rtpParametersSchema, srtpParametersSchema };
