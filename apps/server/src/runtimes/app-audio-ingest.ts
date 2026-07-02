import type { RtpParameters, SrtpCryptoSuite } from 'mediasoup/types';

// Fixed, server-authored ingest parameters for native desktop app/system audio.
// The desktop RTP sender MUST mirror these exactly so the PlainTransport producer
// has an unambiguous target. Everything here is constant except the SSRC, which is
// allocated per ingest (see allocateAppAudioSsrc).
export const APP_AUDIO_SRTP_CRYPTO_SUITE: SrtpCryptoSuite = 'AES_CM_128_HMAC_SHA1_80';
export const APP_AUDIO_PAYLOAD_TYPE = 100;
export const APP_AUDIO_CLOCK_RATE = 48_000;
export const APP_AUDIO_CHANNELS = 2;
// The PlainTransport 'tuple' event (first received RTP) must fire within this
// window or the ingest is torn down and the client falls back to the worklet.
export const APP_AUDIO_FIRST_MEDIA_TIMEOUT_MS = 3_000;

// SSRC is allocated per ingest so two users publishing app audio into the same
// router never collide. A process-wide monotonic counter guarantees uniqueness
// without tracking live SSRCs; it is seeded randomly inside a reserved 28-bit
// sub-range that stays clear of 0 and the top of the 32-bit space.
const APP_AUDIO_SSRC_BASE = 0x4150_0000;
const APP_AUDIO_SSRC_SPAN = 0x1000_0000;
let appAudioSsrcCounter = Math.floor(Math.random() * APP_AUDIO_SSRC_SPAN);

export const allocateAppAudioSsrc = (): number => {
	appAudioSsrcCounter = (appAudioSsrcCounter + 1) % APP_AUDIO_SSRC_SPAN;

	return APP_AUDIO_SSRC_BASE + appAudioSsrcCounter;
};

// Built per ingest with the allocated SSRC. The codec mirrors the router's
// audio/opus entry (voice.ts defaultRouterOptions) so mediasoup accepts the
// producer; useinbandfec matches the client encoder hint.
export const buildAppAudioRtpParameters = (ssrc: number, userId: number): RtpParameters => ({
	codecs: [
		{
			mimeType: 'audio/opus',
			payloadType: APP_AUDIO_PAYLOAD_TYPE,
			clockRate: APP_AUDIO_CLOCK_RATE,
			channels: APP_AUDIO_CHANNELS,
			parameters: { useinbandfec: 1 },
			rtcpFeedback: [],
		},
	],
	encodings: [{ ssrc }],
	rtcp: { cname: `app-audio-${userId}` },
});
