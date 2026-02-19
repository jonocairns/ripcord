type TVideoBitrateProfile = 'camera' | 'screen';

type TVideoBitratePolicyInput = {
  profile: TVideoBitrateProfile;
  width?: number;
  height?: number;
  frameRate?: number;
  codecMimeType?: string;
};

type TVideoBitratePolicy = {
  minKbps: number;
  startKbps: number;
  maxKbps: number;
  maxBitrateBps: number;
};

type TPolicyTuning = {
  baseWidth: number;
  baseHeight: number;
  baseFrameRate: number;
  exponent: number;
  baseMinKbps: number;
  baseStartKbps: number;
  baseMaxKbps: number;
  minRange: [number, number];
  startRange: [number, number];
  maxRange: [number, number];
};

const POLICY_TUNING: Record<TVideoBitrateProfile, TPolicyTuning> = {
  camera: {
    baseWidth: 1280,
    baseHeight: 720,
    baseFrameRate: 30,
    exponent: 0.65,
    baseMinKbps: 700,
    baseStartKbps: 1400,
    baseMaxKbps: 2800,
    minRange: [250, 6000],
    startRange: [500, 12000],
    maxRange: [1000, 18000]
  },
  screen: {
    baseWidth: 1920,
    baseHeight: 1080,
    baseFrameRate: 30,
    exponent: 0.75,
    baseMinKbps: 3000,
    baseStartKbps: 5000,
    baseMaxKbps: 9000,
    minRange: [600, 18000],
    startRange: [1200, 30000],
    maxRange: [2500, 45000]
  }
};

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

const roundKbps = (value: number) => {
  return Math.max(1, Math.round(value / 50) * 50);
};

const getCodecBitrateMultiplier = (codecMimeType?: string) => {
  const normalized = codecMimeType?.toLowerCase();

  if (!normalized) {
    return 1;
  }

  if (normalized === 'video/av1') {
    return 0.75;
  }

  if (normalized === 'video/h265' || normalized === 'video/hevc') {
    return 0.85;
  }

  if (normalized === 'video/vp8') {
    return 1.15;
  }

  return 1;
};

const getVideoBitratePolicy = ({
  profile,
  width,
  height,
  frameRate,
  codecMimeType
}: TVideoBitratePolicyInput): TVideoBitratePolicy => {
  const tuning = POLICY_TUNING[profile];
  const safeWidth = clamp(width ?? tuning.baseWidth, 160, 7680);
  const safeHeight = clamp(height ?? tuning.baseHeight, 120, 4320);
  const safeFrameRate = clamp(frameRate ?? tuning.baseFrameRate, 5, 120);

  const pixelRate = safeWidth * safeHeight * safeFrameRate;
  const basePixelRate =
    tuning.baseWidth * tuning.baseHeight * tuning.baseFrameRate;
  const relativePixelRate = clamp(pixelRate / basePixelRate, 0.1, 20);
  const scaledRate = Math.pow(relativePixelRate, tuning.exponent);
  const codecMultiplier = getCodecBitrateMultiplier(codecMimeType);

  let minKbps = clamp(
    tuning.baseMinKbps * scaledRate * codecMultiplier,
    tuning.minRange[0],
    tuning.minRange[1]
  );
  let startKbps = clamp(
    tuning.baseStartKbps * scaledRate * codecMultiplier,
    tuning.startRange[0],
    tuning.startRange[1]
  );
  let maxKbps = clamp(
    tuning.baseMaxKbps * scaledRate * codecMultiplier,
    tuning.maxRange[0],
    tuning.maxRange[1]
  );

  startKbps = Math.max(startKbps, minKbps * 1.25);
  maxKbps = Math.max(maxKbps, startKbps * 1.25);

  if (startKbps > tuning.startRange[1]) {
    startKbps = tuning.startRange[1];
  }
  if (maxKbps > tuning.maxRange[1]) {
    maxKbps = tuning.maxRange[1];
  }

  if (startKbps >= maxKbps) {
    startKbps = maxKbps * 0.8;
  }

  if (minKbps >= startKbps) {
    minKbps = startKbps * 0.7;
  }

  minKbps = roundKbps(
    clamp(minKbps, tuning.minRange[0], Math.max(tuning.minRange[0], startKbps))
  );
  startKbps = roundKbps(
    clamp(
      startKbps,
      Math.max(tuning.startRange[0], minKbps),
      Math.max(tuning.startRange[0], maxKbps)
    )
  );
  maxKbps = roundKbps(
    clamp(maxKbps, Math.max(tuning.maxRange[0], startKbps), tuning.maxRange[1])
  );

  return {
    minKbps,
    startKbps,
    maxKbps,
    maxBitrateBps: maxKbps * 1000
  };
};

export { getVideoBitratePolicy };
export type { TVideoBitratePolicy, TVideoBitratePolicyInput, TVideoBitrateProfile };
