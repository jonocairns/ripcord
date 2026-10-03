import type { RtpCapabilities, RtpCodecCapability } from 'mediasoup-client/types';
import { logVoice } from '@/helpers/browser-logger';
import { VideoCodecPreference } from '@/types';
import { getVideoBitratePolicy, type TVideoBitrateCodec, type TVideoBitratePolicy } from './video-bitrate-policy';

const VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE: Record<string, string> = {
	[VideoCodecPreference.VP8]: 'video/VP8',
	[VideoCodecPreference.VP9]: 'video/VP9',
	[VideoCodecPreference.H264]: 'video/H264',
};

// Screen and webcam captures are both motion content, so their sender
// `contentHint` is 'motion'. That alone would default degradationPreference to
// 'maintain-framerate' (drop resolution to hold fps). We override it to
// 'balanced' so the encoder can trade a little of both under bitrate/CPU
// pressure instead of collapsing frame rate the way 'detail' +
// 'maintain-resolution' did on high-motion captures.
//
// Lives in this leaf configuration module because both the voice provider (initial
// publish) and the screen-share quality guard (floor release) need it without
// creating a hook -> provider import cycle.
const VIDEO_DEGRADATION_PREFERENCE: RTCDegradationPreference = 'balanced';

// Temporal SVC for video producers: one spatial layer (single encode, single
// resolution) split into three temporal layers (~T0/T1/T2 frame-rate tiers).
// This is the cheap kind of layering — reference-structure bookkeeping, not
// re-encoding — so there's no meaningful streamer CPU cost. It lets the SFU
// shed a temporal layer per slow viewer (graceful frame-rate drop instead of a
// frozen/stuttering stream + PLI storms), and reinforces the degradation
// preference under bitrate pressure. The bitrate configuration below adds a
// per-codec ceiling. Best on VP9; hardware H264 may fall back to a single layer
// (L1T1), which is harmless.
const VIDEO_SCALABILITY_MODE = 'L1T3';

type TVideoProducerEncoding = {
	scalabilityMode?: string;
	maxBitrate?: number;
};

const createVideoProducerEncodings = (): TVideoProducerEncoding[] => {
	return [{ scalabilityMode: VIDEO_SCALABILITY_MODE }];
};

// Map the resolved/effective send codec to a bitrate-policy codec so the
// max-bitrate ceiling can be scaled per codec. When no codec is resolved (AUTO
// where mediasoup-client picks a default internally) we fall back to 'auto'.
const getBitrateCodecFromMimeType = (codec: RtpCodecCapability | undefined): TVideoBitrateCodec => {
	const mimeType = codec?.mimeType.toLowerCase();

	if (mimeType === 'video/h264') return 'h264';
	if (mimeType === 'video/vp8') return 'vp8';
	if (mimeType === 'video/vp9') return 'vp9';

	return 'auto';
};

const resolvePreferredVideoCodec = (
	rtpCapabilities: RtpCapabilities | null,
	preference: VideoCodecPreference,
): RtpCodecCapability | undefined => {
	if (!rtpCapabilities || preference === VideoCodecPreference.AUTO) {
		return undefined;
	}

	const preferredMimeType = VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE[preference]?.toLowerCase();

	if (!preferredMimeType) {
		return undefined;
	}

	return (rtpCapabilities.codecs ?? []).find((codec) => {
		return codec.mimeType.toLowerCase() === preferredMimeType;
	});
};

const findVideoCodecByMime = (
	rtpCapabilities: RtpCapabilities | null,
	mimeType: string,
): RtpCodecCapability | undefined => {
	const lowerMimeType = mimeType.toLowerCase();

	return (rtpCapabilities?.codecs ?? []).find((codec) => {
		return codec.mimeType.toLowerCase() === lowerMimeType;
	});
};

type TScreenShareEncodeParams = {
	width: number;
	height: number;
	framerate: number;
	bitrate: number;
};

// Resolve the screen share send codec.
// - AUTO: prefer H264; it has broad hardware-encoder support and is universally
//   decodable by viewers. Without this, mediasoup-client's default pick is the
//   first negotiated codec (VP8), silently landing software encoding on
//   demanding shares.
// - Explicit VP9/VP8/H264: use as chosen; the caller knowingly accepts the
//   (often software-encoded) CPU trade-off for VP9/VP8.
const resolveScreenShareVideoCodec = (
	rtpCapabilities: RtpCapabilities | null,
	preference: VideoCodecPreference,
	encodeParams: TScreenShareEncodeParams,
): RtpCodecCapability | undefined => {
	const h264Codec = findVideoCodecByMime(rtpCapabilities, 'video/H264');

	if (preference === VideoCodecPreference.AUTO) {
		if (!h264Codec) {
			logVoice('H264 screen share codec unavailable for auto selection, falling back to mediasoup default codec', {
				...encodeParams,
			});
		}

		return h264Codec;
	}

	return resolvePreferredVideoCodec(rtpCapabilities, preference);
};

const applyVideoDegradationPreference = async (sender: RTCRtpSender | undefined, label: string): Promise<void> => {
	if (!sender) {
		logVoice('RTCRtpSender unavailable, skipping degradationPreference override', { label });
		return;
	}

	try {
		// setParameters must be passed the object from the immediately preceding
		// getParameters — they're coupled by its transactionId. Keep this read /
		// modify / write atomic: any other setParameters landing on this sender
		// in between would invalidate the transactionId and reject with
		// InvalidStateError. A future concurrent path (e.g. simulcast layer
		// toggling) must serialise against this, not interleave.
		const params = sender.getParameters();

		if (params.degradationPreference === VIDEO_DEGRADATION_PREFERENCE) {
			return;
		}

		params.degradationPreference = VIDEO_DEGRADATION_PREFERENCE;
		await sender.setParameters(params);
	} catch (error) {
		logVoice('Failed to set degradationPreference', { label, error });
	}
};

type TVideoProducerConfigInput = {
	rtpCapabilities: RtpCapabilities | null;
	preference: VideoCodecPreference;
	width: number;
	height: number;
	frameRate: number;
};

const createVideoProducerConfig = (codec: RtpCodecCapability | undefined, bitratePolicy: TVideoBitratePolicy) => ({
	codec,
	// Preserve temporal SVC while giving congestion control room to ramp during
	// high-motion content before it resorts to downscaling.
	encodings: createVideoProducerEncodings().map((encoding) => ({
		...encoding,
		maxBitrate: bitratePolicy.maxKbps * 1000,
	})),
	codecOptions: {
		videoGoogleStartBitrate: bitratePolicy.startKbps,
		videoGoogleMaxBitrate: bitratePolicy.maxKbps,
	},
});

const getWebcamVideoProducerConfig = ({
	rtpCapabilities,
	preference,
	width,
	height,
	frameRate,
}: TVideoProducerConfigInput) => {
	const codec = resolvePreferredVideoCodec(rtpCapabilities, preference);

	if (preference !== VideoCodecPreference.AUTO && !codec) {
		logVoice('Preferred webcam codec unavailable, falling back to auto', {
			preferredCodec: preference,
		});
	}

	const bitratePolicy = getVideoBitratePolicy({
		profile: 'camera',
		width,
		height,
		frameRate,
		codec: getBitrateCodecFromMimeType(codec),
	});

	logVoice('Webcam bitrate policy resolved', {
		width,
		height,
		frameRate,
		codec: codec?.mimeType,
		startKbps: bitratePolicy.startKbps,
		maxKbps: bitratePolicy.maxKbps,
	});

	return createVideoProducerConfig(codec, bitratePolicy);
};

const getScreenShareVideoProducerConfig = ({
	rtpCapabilities,
	preference,
	width,
	height,
	frameRate,
}: TVideoProducerConfigInput) => {
	// Resolve the codec using a codec-agnostic base policy, then recompute the
	// policy's max ceiling for the selected codec.
	const baseBitratePolicy = getVideoBitratePolicy({ profile: 'screen', width, height, frameRate });
	const codec = resolveScreenShareVideoCodec(rtpCapabilities, preference, {
		width,
		height,
		framerate: frameRate,
		bitrate: baseBitratePolicy.startKbps * 1000,
	});

	if (preference !== VideoCodecPreference.AUTO && !codec) {
		logVoice('Preferred screen share codec unavailable, falling back to auto', {
			preferredCodec: preference,
		});
	}

	const bitratePolicy = getVideoBitratePolicy({
		profile: 'screen',
		width,
		height,
		frameRate,
		codec: getBitrateCodecFromMimeType(codec),
	});

	logVoice('Screen share bitrate policy resolved', {
		width,
		height,
		frameRate,
		codec: codec?.mimeType,
		startKbps: bitratePolicy.startKbps,
		maxKbps: bitratePolicy.maxKbps,
	});

	return createVideoProducerConfig(codec, bitratePolicy);
};

export {
	applyVideoDegradationPreference,
	getScreenShareVideoProducerConfig,
	getWebcamVideoProducerConfig,
	VIDEO_DEGRADATION_PREFERENCE,
};
