import { describe, expect, it } from 'bun:test';
import type { RtpCapabilities, RtpCodecCapability } from 'mediasoup-client/types';
import { VideoCodecPreference } from '@/types';
import { getScreenShareVideoProducerConfig, getWebcamVideoProducerConfig } from '../video-producer-config';

const vp8: RtpCodecCapability = { kind: 'video', mimeType: 'video/VP8', clockRate: 90_000, preferredPayloadType: 96 };
const vp9: RtpCodecCapability = { kind: 'video', mimeType: 'VIDEO/vp9', clockRate: 90_000, preferredPayloadType: 98 };
const h264: RtpCodecCapability = {
	kind: 'video',
	mimeType: 'video/H264',
	clockRate: 90_000,
	preferredPayloadType: 102,
};
const capabilities: RtpCapabilities = { codecs: [vp8, vp9, h264] };
const dimensions = { width: 1920, height: 1080, frameRate: 30 };

for (const { name, resolve } of [
	{ name: 'webcam', resolve: getWebcamVideoProducerConfig },
	{ name: 'screen share', resolve: getScreenShareVideoProducerConfig },
]) {
	describe(`${name} codec selection`, () => {
		it.each([
			{ preference: VideoCodecPreference.VP8, codec: vp8 },
			{ preference: VideoCodecPreference.VP9, codec: vp9 },
			{ preference: VideoCodecPreference.H264, codec: h264 },
		])('uses the negotiated $preference codec, matching MIME types case-insensitively', ({ preference, codec }) => {
			const config = resolve({ rtpCapabilities: capabilities, preference, ...dimensions });
			expect(config.codec).toBe(codec);
		});

		it('leaves selection to mediasoup when an explicit preference is unavailable, even if H264 is present', () => {
			const config = resolve({
				rtpCapabilities: { codecs: [vp8, h264] },
				preference: VideoCodecPreference.VP9,
				...dimensions,
			});
			expect(config.codec).toBeUndefined();
		});

		it.each([null, {}])('leaves selection to mediasoup when capabilities have no codecs: %j', (rtpCapabilities) => {
			const config = resolve({ rtpCapabilities, preference: VideoCodecPreference.H264, ...dimensions });
			expect(config.codec).toBeUndefined();
		});
	});
}

describe('automatic codec selection', () => {
	it('leaves webcam AUTO selection to mediasoup even when H264 is available', () => {
		const config = getWebcamVideoProducerConfig({
			rtpCapabilities: capabilities,
			preference: VideoCodecPreference.AUTO,
			...dimensions,
		});
		expect(config.codec).toBeUndefined();
	});

	it('prefers H264 for screen AUTO even when VP8 and VP9 come first', () => {
		const config = getScreenShareVideoProducerConfig({
			rtpCapabilities: capabilities,
			preference: VideoCodecPreference.AUTO,
			...dimensions,
		});
		expect(config.codec).toBe(h264);
	});

	it('leaves screen AUTO selection to mediasoup when H264 is unavailable', () => {
		const config = getScreenShareVideoProducerConfig({
			rtpCapabilities: { codecs: [vp8, vp9] },
			preference: VideoCodecPreference.AUTO,
			...dimensions,
		});
		expect(config.codec).toBeUndefined();
		expect(config.encodings[0]?.maxBitrate).toBe(8_500_000);
	});
});

describe('video producer bitrate configuration', () => {
	it.each([
		{ preference: VideoCodecPreference.VP8, maxKbps: 9775 },
		{ preference: VideoCodecPreference.VP9, maxKbps: 7650 },
		{ preference: VideoCodecPreference.AUTO, maxKbps: 8500 },
	])('uses the resolved $preference screen codec for both encoding and codec ceilings', ({ preference, maxKbps }) => {
		const config = getScreenShareVideoProducerConfig({ rtpCapabilities: capabilities, preference, ...dimensions });
		expect(config.encodings).toEqual([{ scalabilityMode: 'L1T3', maxBitrate: maxKbps * 1000 }]);
		expect(config.codecOptions).toEqual({ videoGoogleStartBitrate: 2800, videoGoogleMaxBitrate: maxKbps });
	});

	it('uses the auto bitrate ceiling when an explicit codec is unavailable', () => {
		const config = getScreenShareVideoProducerConfig({
			rtpCapabilities: { codecs: [vp8] },
			preference: VideoCodecPreference.VP9,
			...dimensions,
		});
		expect(config.encodings[0]?.maxBitrate).toBe(8_500_000);
		expect(config.codecOptions.videoGoogleMaxBitrate).toBe(8500);
	});

	it('caps high-resolution screen startup while retaining its codec-specific ceiling', () => {
		const config = getScreenShareVideoProducerConfig({
			rtpCapabilities: capabilities,
			preference: VideoCodecPreference.VP9,
			width: 3840,
			height: 2160,
			frameRate: 60,
		});
		expect(config.codecOptions).toEqual({ videoGoogleStartBitrate: 4000, videoGoogleMaxBitrate: 31_500 });
		expect(config.encodings[0]?.maxBitrate).toBe(31_500_000);
	});

	it('uses camera buckets and the selected codec instead of screen bitrate policy', () => {
		const config = getWebcamVideoProducerConfig({
			rtpCapabilities: capabilities,
			preference: VideoCodecPreference.VP8,
			...dimensions,
		});
		expect(config.codecOptions).toEqual({ videoGoogleStartBitrate: 2200, videoGoogleMaxBitrate: 5175 });
		expect(config.encodings[0]?.maxBitrate).toBe(5_175_000);
	});
});
