type TVideoBitrateProfile = 'camera' | 'screen';

type TVideoBitrateCodec = 'auto' | 'h264' | 'vp8' | 'vp9' | 'av1';

type TVideoBitratePolicyInput = {
	profile: TVideoBitrateProfile;
	width?: number;
	height?: number;
	frameRate?: number;
	codec?: TVideoBitrateCodec;
};

type TVideoBitratePolicy = {
	startKbps: number;
	maxKbps: number;
};

type TFpsTier = {
	maxFrameRate: number;
	startKbps: number;
	maxKbps: number;
};

type TResolutionTier = {
	maxPixels: number;
	fpsTiers: TFpsTier[];
};

const BITRATE_TABLE: Record<TVideoBitrateProfile, TResolutionTier[]> = {
	camera: [
		{
			maxPixels: 640 * 360,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 600, maxKbps: 900 },
				{ maxFrameRate: 30, startKbps: 900, maxKbps: 1400 },
				{ maxFrameRate: 60, startKbps: 1400, maxKbps: 2200 },
				{ maxFrameRate: 120, startKbps: 2200, maxKbps: 3500 },
			],
		},
		{
			maxPixels: 1280 * 720,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 900, maxKbps: 1600 },
				{ maxFrameRate: 30, startKbps: 1400, maxKbps: 2500 },
				{ maxFrameRate: 60, startKbps: 2200, maxKbps: 4000 },
				{ maxFrameRate: 120, startKbps: 3500, maxKbps: 6500 },
			],
		},
		{
			maxPixels: 1920 * 1080,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 1400, maxKbps: 2600 },
				{ maxFrameRate: 30, startKbps: 2200, maxKbps: 4500 },
				{ maxFrameRate: 60, startKbps: 3500, maxKbps: 7000 },
				{ maxFrameRate: 120, startKbps: 5200, maxKbps: 10000 },
			],
		},
		{
			maxPixels: 2560 * 1440,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 2200, maxKbps: 4500 },
				{ maxFrameRate: 30, startKbps: 3200, maxKbps: 7000 },
				{ maxFrameRate: 60, startKbps: 5000, maxKbps: 10000 },
				{ maxFrameRate: 120, startKbps: 7500, maxKbps: 15000 },
			],
		},
		{
			maxPixels: 7680 * 4320,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 3200, maxKbps: 7000 },
				{ maxFrameRate: 30, startKbps: 4500, maxKbps: 10000 },
				{ maxFrameRate: 60, startKbps: 7000, maxKbps: 16000 },
				{ maxFrameRate: 120, startKbps: 11000, maxKbps: 24000 },
			],
		},
	],
	screen: [
		{
			maxPixels: 1280 * 720,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 1800, maxKbps: 3500 },
				{ maxFrameRate: 30, startKbps: 3000, maxKbps: 6000 },
				{ maxFrameRate: 60, startKbps: 4500, maxKbps: 9000 },
				{ maxFrameRate: 120, startKbps: 7000, maxKbps: 14000 },
			],
		},
		{
			maxPixels: 1920 * 1080,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 3200, maxKbps: 7000 },
				{ maxFrameRate: 30, startKbps: 6000, maxKbps: 12000 },
				{ maxFrameRate: 60, startKbps: 9000, maxKbps: 18000 },
				{ maxFrameRate: 120, startKbps: 13000, maxKbps: 26000 },
			],
		},
		{
			maxPixels: 2560 * 1440,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 4600, maxKbps: 10000 },
				{ maxFrameRate: 30, startKbps: 9000, maxKbps: 18000 },
				{ maxFrameRate: 60, startKbps: 14000, maxKbps: 28000 },
				{ maxFrameRate: 120, startKbps: 20000, maxKbps: 40000 },
			],
		},
		{
			maxPixels: 3840 * 2160,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 7000, maxKbps: 18000 },
				{ maxFrameRate: 30, startKbps: 14000, maxKbps: 30000 },
				{ maxFrameRate: 60, startKbps: 22000, maxKbps: 45000 },
				{ maxFrameRate: 120, startKbps: 32000, maxKbps: 70000 },
			],
		},
		{
			maxPixels: 7680 * 4320,
			fpsTiers: [
				{ maxFrameRate: 15, startKbps: 9000, maxKbps: 24000 },
				{ maxFrameRate: 30, startKbps: 14000, maxKbps: 40000 },
				{ maxFrameRate: 60, startKbps: 22000, maxKbps: 70000 },
				{ maxFrameRate: 120, startKbps: 30000, maxKbps: 100000 },
			],
		},
	],
};

// The baseline table is tuned for H.264-ish screen-motion bitrate. Different
// codecs need different ceilings for equivalent quality: VP8 wants a touch more
// headroom, while VP9/AV1 hit the same quality at a lower rate. Only the max
// ceiling is scaled — startKbps is left alone so ramp-up isn't starved during
// motion (a low start bitrate makes the downscale-during-motion problem worse).
const CODEC_MAX_BITRATE_MULTIPLIER: Record<TVideoBitrateCodec, number> = {
	auto: 1,
	h264: 1,
	vp8: 1.15,
	vp9: 0.9,
	av1: 0.8,
};

const applyCodecMaxBitrateMultiplier = (maxKbps: number, codec?: TVideoBitrateCodec) => {
	const multiplier = CODEC_MAX_BITRATE_MULTIPLIER[codec ?? 'auto'] ?? 1;
	return Math.round(maxKbps * multiplier);
};

const clamp = (value: number, min: number, max: number) => {
	return Math.max(min, Math.min(max, value));
};

const resolveResolutionTier = (tiers: TResolutionTier[], pixelCount: number): TResolutionTier => {
	return tiers.find((tier) => pixelCount <= tier.maxPixels) ?? tiers[tiers.length - 1]!;
};

const resolveFpsTier = (tiers: TFpsTier[], frameRate: number): TFpsTier => {
	return tiers.find((tier) => frameRate <= tier.maxFrameRate) ?? tiers[tiers.length - 1]!;
};

const getVideoBitratePolicy = ({
	profile,
	width,
	height,
	frameRate,
	codec,
}: TVideoBitratePolicyInput): TVideoBitratePolicy => {
	const safeWidth = clamp(width ?? 1280, 160, 7680);
	const safeHeight = clamp(height ?? 720, 120, 4320);
	const safeFrameRate = clamp(frameRate ?? 30, 5, 120);
	const pixelCount = safeWidth * safeHeight;

	const resolutionTier = resolveResolutionTier(BITRATE_TABLE[profile], pixelCount);
	const fpsTier = resolveFpsTier(resolutionTier.fpsTiers, safeFrameRate);

	return {
		startKbps: fpsTier.startKbps,
		maxKbps: applyCodecMaxBitrateMultiplier(fpsTier.maxKbps, codec),
	};
};

export type { TVideoBitrateCodec, TVideoBitratePolicy, TVideoBitratePolicyInput, TVideoBitrateProfile };
export { getVideoBitratePolicy };
