type TVideoBitrateProfile = 'camera' | 'screen';

type TVideoBitratePolicyInput = {
  profile: TVideoBitrateProfile;
  width?: number;
  height?: number;
  frameRate?: number;
  codecMimeType?: string;
};

type TVideoBitratePolicy = {
  startKbps: number;
};

type TFpsTier = {
  maxFrameRate: number;
  startKbps: number;
};

type TResolutionTier = {
  maxPixels: number;
  fpsTiers: TFpsTier[];
};

const START_BITRATE_TABLE: Record<TVideoBitrateProfile, TResolutionTier[]> = {
  camera: [
    {
      maxPixels: 640 * 360,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 600 },
        { maxFrameRate: 30, startKbps: 900 },
        { maxFrameRate: 60, startKbps: 1400 },
        { maxFrameRate: 120, startKbps: 2200 }
      ]
    },
    {
      maxPixels: 1280 * 720,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 900 },
        { maxFrameRate: 30, startKbps: 1400 },
        { maxFrameRate: 60, startKbps: 2200 },
        { maxFrameRate: 120, startKbps: 3500 }
      ]
    },
    {
      maxPixels: 1920 * 1080,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 1400 },
        { maxFrameRate: 30, startKbps: 2200 },
        { maxFrameRate: 60, startKbps: 3500 },
        { maxFrameRate: 120, startKbps: 5200 }
      ]
    },
    {
      maxPixels: 2560 * 1440,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 2200 },
        { maxFrameRate: 30, startKbps: 3200 },
        { maxFrameRate: 60, startKbps: 5000 },
        { maxFrameRate: 120, startKbps: 7500 }
      ]
    },
    {
      maxPixels: 7680 * 4320,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 3200 },
        { maxFrameRate: 30, startKbps: 4500 },
        { maxFrameRate: 60, startKbps: 7000 },
        { maxFrameRate: 120, startKbps: 11000 }
      ]
    }
  ],
  screen: [
    {
      maxPixels: 1280 * 720,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 1800 },
        { maxFrameRate: 30, startKbps: 2800 },
        { maxFrameRate: 60, startKbps: 4200 },
        { maxFrameRate: 120, startKbps: 6500 }
      ]
    },
    {
      maxPixels: 1920 * 1080,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 3200 },
        { maxFrameRate: 30, startKbps: 5000 },
        { maxFrameRate: 60, startKbps: 7600 },
        { maxFrameRate: 120, startKbps: 11000 }
      ]
    },
    {
      maxPixels: 2560 * 1440,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 4600 },
        { maxFrameRate: 30, startKbps: 7000 },
        { maxFrameRate: 60, startKbps: 10500 },
        { maxFrameRate: 120, startKbps: 15000 }
      ]
    },
    {
      maxPixels: 3840 * 2160,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 7000 },
        { maxFrameRate: 30, startKbps: 10500 },
        { maxFrameRate: 60, startKbps: 15000 },
        { maxFrameRate: 120, startKbps: 22000 }
      ]
    },
    {
      maxPixels: 7680 * 4320,
      fpsTiers: [
        { maxFrameRate: 15, startKbps: 9000 },
        { maxFrameRate: 30, startKbps: 14000 },
        { maxFrameRate: 60, startKbps: 22000 },
        { maxFrameRate: 120, startKbps: 30000 }
      ]
    }
  ]
};

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

const resolveResolutionTier = (
  tiers: TResolutionTier[],
  pixelCount: number
): TResolutionTier => {
  return (
    tiers.find((tier) => pixelCount <= tier.maxPixels) ??
    tiers[tiers.length - 1]!
  );
};

const resolveFpsTier = (tiers: TFpsTier[], frameRate: number): TFpsTier => {
  return (
    tiers.find((tier) => frameRate <= tier.maxFrameRate) ??
    tiers[tiers.length - 1]!
  );
};

const getVideoBitratePolicy = ({
  profile,
  width,
  height,
  frameRate,
  codecMimeType
}: TVideoBitratePolicyInput): TVideoBitratePolicy => {
  // Start bitrate now follows explicit resolution/fps buckets.
  void codecMimeType;

  const safeWidth = clamp(width ?? 1280, 160, 7680);
  const safeHeight = clamp(height ?? 720, 120, 4320);
  const safeFrameRate = clamp(frameRate ?? 30, 5, 120);
  const pixelCount = safeWidth * safeHeight;

  const resolutionTier = resolveResolutionTier(
    START_BITRATE_TABLE[profile],
    pixelCount
  );
  const fpsTier = resolveFpsTier(resolutionTier.fpsTiers, safeFrameRate);

  return {
    startKbps: fpsTier.startKbps
  };
};

export { getVideoBitratePolicy };
export type {
  TVideoBitratePolicy,
  TVideoBitratePolicyInput,
  TVideoBitrateProfile
};
