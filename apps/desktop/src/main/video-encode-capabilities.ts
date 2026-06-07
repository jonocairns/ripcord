import { app } from "electron";
import type {
  TVideoEncodeAcceleratorProfile,
  TVideoEncodeCapabilities,
  TVideoEncodeCodec,
} from "./types";

// Chromium media::VideoCodecProfile numeric ranges, pinned to the Chromium
// build shipped with the current Electron (148 — see DEPS for the Electron
// version in apps/desktop/package.json). These values have shifted historically
// (HEVC range-extension profiles were inserted *after* AV1, and DolbyVision sits
// between HEVC main and AV1), so an Electron/Chromium major bump can move them.
//
// IMPORTANT: re-verify against media/base/video_codecs.h when bumping Electron.
// We attach the raw profile number to every entry so drift is observable in the
// GPU diagnostics file, and the renderer treats hardware AV1 as an *additive*,
// guarded signal — a stale mapping degrades to the WebRTC mediaCapabilities
// probe rather than misbehaving.
const codecForProfile = (profile: number): TVideoEncodeCodec => {
  if (profile >= 0 && profile <= 10) return "h264";
  if (profile === 11) return "vp8";
  if (profile >= 12 && profile <= 15) return "vp9";
  if (profile >= 16 && profile <= 18) return "hevc";
  // DolbyVision is non-contiguous: profiles 19-23 sit before AV1, and
  // DOLBYVISION_PROFILE8/9 (27-28) sit after it.
  if (profile >= 19 && profile <= 23) return "dolbyvision";
  if (profile >= 24 && profile <= 26) return "av1";
  if (profile >= 27 && profile <= 28) return "dolbyvision";
  if (profile >= 29 && profile <= 36) return "hevc";
  return "unknown";
};

type TRawEncodeProfile = {
  profile?: unknown;
  maxResolution?: { width?: unknown; height?: unknown };
};

const toFiniteNumber = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

// Resolve the GPU's authoritative hardware video-encode capability. Unlike the
// renderer's mediaCapabilities.encodingInfo probe (whose powerEfficient flag is
// unreliable for WebRTC AV1), getGPUInfo('complete') reports the actual
// hardware-accelerated encode profiles per codec.
const computeVideoEncodeCapabilities =
  async (): Promise<TVideoEncodeCapabilities> => {
    let hardwareVideoEncodeEnabled = false;
    try {
      hardwareVideoEncodeEnabled =
        app.getGPUFeatureStatus().video_encode === "enabled";
    } catch {
      hardwareVideoEncodeEnabled = false;
    }

    let rawProfiles: TRawEncodeProfile[] = [];
    try {
      const gpuInfo = (await app.getGPUInfo("complete")) as {
        videoEncodeAcceleratorSupportedProfiles?: TRawEncodeProfile[];
      };

      if (Array.isArray(gpuInfo?.videoEncodeAcceleratorSupportedProfiles)) {
        rawProfiles = gpuInfo.videoEncodeAcceleratorSupportedProfiles;
      }
    } catch {
      rawProfiles = [];
    }

    const profiles: TVideoEncodeAcceleratorProfile[] = rawProfiles.map(
      (entry) => {
        const rawProfile = toFiniteNumber(entry.profile);

        return {
          codec: codecForProfile(rawProfile),
          rawProfile,
          maxWidth: toFiniteNumber(entry.maxResolution?.width),
          maxHeight: toFiniteNumber(entry.maxResolution?.height),
        };
      },
    );

    return { hardwareVideoEncodeEnabled, profiles };
  };

// GPU encode profiles are static for the process lifetime and getGPUInfo
// ('complete') is a slow driver call, so resolve once and memoize the promise
// (this also dedupes concurrent callers). computeVideoEncodeCapabilities never
// rejects, so the cached promise always resolves.
let cachedCapabilitiesPromise: Promise<TVideoEncodeCapabilities> | undefined;

const resolveVideoEncodeCapabilities = (): Promise<TVideoEncodeCapabilities> => {
  cachedCapabilitiesPromise ??= computeVideoEncodeCapabilities();
  return cachedCapabilitiesPromise;
};

export { resolveVideoEncodeCapabilities };
