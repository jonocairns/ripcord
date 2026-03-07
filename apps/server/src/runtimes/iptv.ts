import {
  ServerEvents,
  StreamKind,
  type TIptvChannel,
  type TIptvStatus
} from '@sharkord/shared';
import { spawn, type ChildProcess } from 'child_process';
import { eq } from 'drizzle-orm';
import type {
  AppData,
  PlainTransport,
  Producer,
  RtpParameters
} from 'mediasoup/types';
import { db } from '../db';
import { iptvSources } from '../db/schema';
import { logger } from '../logger';
import { eventBus } from '../plugins/event-bus';
import {
  assertSafeIptvUrl,
  fetchAndParsePlaylist
} from '../utils/iptv-playlist';
import { pubsub } from '../utils/pubsub';
import { VoiceRuntime } from './voice';

const IPTV_PLUGIN_ID = '__iptv__';
const VIDEO_PAYLOAD_TYPE = 96;
const AUDIO_PAYLOAD_TYPE = 97;
const MAX_SSRC = 0xffff_fffe;
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const STABLE_STREAM_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 10_000;
const AUTO_STOP_NO_VIEWERS_MS = 15_000;
const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_EXIT_GRACE_MS = 1500;
const FFMPEG_EXIT_KILL_MS = 1000;
const MAX_TRANSCODE_VIDEO_WIDTH = 1920;
const MAX_TRANSCODE_VIDEO_HEIGHT = 1080;
const MAX_TRANSCODE_VIDEO_FRAME_RATE = 50;
const TRANSCODE_VIDEO_CRF = 18;
const TRANSCODE_VIDEO_MAX_RATE_KBPS = 20_000;
const TRANSCODE_VIDEO_BUFFER_SIZE_KBPS = 40_000;

type TIptvSessionConfig = {
  playlistUrl: string;
  enabled: boolean;
  alwaysTranscodeVideo?: boolean;
  activeChannelIndex?: number | null;
};

type TRecordValue = Record<string, unknown>;
type TIptvSourceProbeSummary = {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  videoFieldOrder?: string;
  videoWidth?: number;
  videoHeight?: number;
  videoFrameRate?: number;
  videoBitrate?: number;
  audioBitrate?: number;
};
type TIptvSourceProbeResult = {
  summary?: TIptvSourceProbeSummary;
  failureReason?: string;
};
type TIptvChannelPreparation = {
  shouldTranscodeVideo: boolean;
  videoCodec?: string;
  videoFilter?: string;
  targetVideoCrf?: number;
  targetVideoMaxRateKbps?: number;
  targetVideoBufferSizeKbps?: number;
};

const isRecord = (value: unknown): value is TRecordValue => {
  return typeof value === 'object' && value !== null;
};

const getNumberProp = (value: unknown, key: string): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const prop = value[key];

  if (typeof prop !== 'number') {
    return undefined;
  }

  return prop;
};

const getStringProp = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const prop = value[key];

  if (typeof prop !== 'string') {
    return undefined;
  }

  return prop;
};

const parseNumericString = (value: string): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
};

const parseProbeFrameRate = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (!normalized.includes('/')) {
    const parsed = parseNumericString(normalized);

    return parsed && parsed > 0 ? parsed : undefined;
  }

  const parts = normalized.split('/');

  if (parts.length !== 2) {
    return undefined;
  }

  const numerator = parseNumericString(parts[0] ?? '');
  const denominator = parseNumericString(parts[1] ?? '');

  if (
    numerator === undefined ||
    denominator === undefined ||
    denominator <= 0
  ) {
    return undefined;
  }

  const frameRate = numerator / denominator;

  return frameRate > 0 ? frameRate : undefined;
};

const parseProbeBitrate = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = parseNumericString(value);

  return parsed && parsed > 0 ? parsed : undefined;
};

const getArrayProp = (value: unknown, key: string): unknown[] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const prop = value[key];

  if (!Array.isArray(prop)) {
    return undefined;
  }

  return prop;
};

const extractByteCount = (stats: unknown[]): number => {
  let total = 0;

  for (const stat of stats) {
    const byteCount = getNumberProp(stat, 'byteCount');

    if (byteCount !== undefined) {
      total += byteCount;
      continue;
    }

    const bytesSent = getNumberProp(stat, 'bytesSent');

    if (bytesSent !== undefined) {
      total += bytesSent;
    }
  }

  return total;
};

const isVideoCopyFailure = (stderrOutput: string): boolean => {
  const normalized = stderrOutput.toLowerCase();

  return [
    'could not find tag for codec',
    'could not write header',
    'tag avc1 incompatible with output codec id',
    'packet header is not contained in global extradata',
    'malformed bitstream',
    'bitstream malformed',
    'global headers'
  ].some((pattern) => normalized.includes(pattern));
};

const inspectSourceStreams = async (
  streamUrl: string
): Promise<TIptvSourceProbeResult> => {
  return await new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,field_order,width,height,avg_frame_rate,r_frame_rate,bit_rate',
      '-of',
      'json',
      streamUrl
    ];
    const ffprobe = spawn('ffprobe', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let stderr = '';
    let resolved = false;

    const finish = (result: TIptvSourceProbeResult) => {
      if (resolved) {
        return;
      }

      resolved = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      ffprobe.kill('SIGKILL');
      finish({
        failureReason: `ffprobe timed out after ${FFPROBE_TIMEOUT_MS}ms`
      });
    }, FFPROBE_TIMEOUT_MS);

    ffprobe.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });

    ffprobe.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();

      if (stderr.length > 10_000) {
        stderr = stderr.slice(-10_000);
      }
    });

    ffprobe.on('error', (error: Error) => {
      clearTimeout(timeout);
      finish({
        failureReason: `ffprobe spawn error: ${error.message}`
      });
    });

    ffprobe.on('close', (code: number | null) => {
      clearTimeout(timeout);
      const stderrTail = getStderrTail(stderr);

      if (code !== 0) {
        finish({
          failureReason: stderrTail
            ? `ffprobe exited with code ${code}; stderr=${stderrTail}`
            : `ffprobe exited with code ${code}`
        });
        return;
      }

      try {
        const parsed: unknown = JSON.parse(output);
        const streams = getArrayProp(parsed, 'streams') ?? [];
        let hasVideo = false;
        let hasAudio = false;
        let videoCodec: string | undefined;
        let audioCodec: string | undefined;
        let videoFieldOrder: string | undefined;
        let videoWidth: number | undefined;
        let videoHeight: number | undefined;
        let videoFrameRate: number | undefined;
        let videoBitrate: number | undefined;
        let audioBitrate: number | undefined;

        for (const stream of streams) {
          const codecType = getStringProp(stream, 'codec_type');
          const codecName = getStringProp(stream, 'codec_name');

          if (codecType === 'video') {
            hasVideo = true;

            if (!videoCodec && codecName) {
              videoCodec = codecName.toLowerCase();
            }

            if (videoFieldOrder === undefined) {
              const fieldOrder = getStringProp(stream, 'field_order');

              if (fieldOrder) {
                videoFieldOrder = fieldOrder.toLowerCase();
              }
            }

            if (videoWidth === undefined) {
              const width = getNumberProp(stream, 'width');

              if (width !== undefined && width > 0) {
                videoWidth = width;
              }
            }

            if (videoHeight === undefined) {
              const height = getNumberProp(stream, 'height');

              if (height !== undefined && height > 0) {
                videoHeight = height;
              }
            }

            if (videoFrameRate === undefined) {
              videoFrameRate =
                parseProbeFrameRate(getStringProp(stream, 'avg_frame_rate')) ??
                parseProbeFrameRate(getStringProp(stream, 'r_frame_rate'));
            }

            if (videoBitrate === undefined && isRecord(stream)) {
              videoBitrate = parseProbeBitrate(stream.bit_rate);
            }
          }

          if (codecType === 'audio') {
            hasAudio = true;

            if (!audioCodec && codecName) {
              audioCodec = codecName.toLowerCase();
            }

            if (audioBitrate === undefined && isRecord(stream)) {
              audioBitrate = parseProbeBitrate(stream.bit_rate);
            }
          }
        }

        finish({
          summary: {
            hasVideo,
            hasAudio,
            videoCodec,
            audioCodec,
            videoFieldOrder,
            videoWidth,
            videoHeight,
            videoFrameRate,
            videoBitrate,
            audioBitrate
          }
        });
      } catch {
        finish({
          failureReason: stderrTail
            ? `ffprobe returned invalid JSON; stderr=${stderrTail}`
            : 'ffprobe returned invalid JSON'
        });
      }
    });
  });
};

const formatCodecLabel = (
  hasStream: boolean,
  codec: string | undefined,
  type: 'video' | 'audio'
): string => {
  if (!hasStream) {
    return `none (${type} stream missing)`;
  }

  return codec ?? `present (${type} codec unknown)`;
};

const formatResolutionLabel = (
  width: number | undefined,
  height: number | undefined
): string | undefined => {
  if (width === undefined || height === undefined) {
    return undefined;
  }

  return `${width}x${height}`;
};

const formatFrameRateLabel = (
  frameRate: number | undefined
): string | undefined => {
  if (frameRate === undefined) {
    return undefined;
  }

  const rounded =
    Math.abs(frameRate - Math.round(frameRate)) < 0.01
      ? String(Math.round(frameRate))
      : frameRate.toFixed(2);

  return `${rounded}fps`;
};

const formatBitrateLabel = (
  bitrate: number | undefined
): string | undefined => {
  if (bitrate === undefined) {
    return undefined;
  }

  return `${(bitrate / 1000).toFixed(0)}kbps`;
};

const formatProbeDetails = (details: Array<string | undefined>): string => {
  const populatedDetails = details.filter(
    (detail): detail is string => detail !== undefined
  );

  if (populatedDetails.length === 0) {
    return ' (details unavailable)';
  }

  return ` (${populatedDetails.join(', ')})`;
};

const formatSourceVideoSummary = (
  probeSummary: TIptvSourceProbeSummary | undefined
): string => {
  if (!probeSummary?.hasVideo) {
    return 'none';
  }

  return `${probeSummary.videoCodec ?? 'unknown'}${formatProbeDetails([
    probeSummary.videoFieldOrder,
    formatResolutionLabel(probeSummary.videoWidth, probeSummary.videoHeight),
    formatFrameRateLabel(probeSummary.videoFrameRate),
    formatBitrateLabel(probeSummary.videoBitrate)
  ])}`;
};

const formatSourceAudioSummary = (
  probeSummary: TIptvSourceProbeSummary | undefined
): string => {
  if (!probeSummary?.hasAudio) {
    return 'none';
  }

  return `${probeSummary.audioCodec ?? 'unknown'}${formatProbeDetails([
    formatBitrateLabel(probeSummary.audioBitrate)
  ])}`;
};

const needsResolutionCap = (
  probeSummary: TIptvSourceProbeSummary | undefined
): boolean => {
  if (!probeSummary?.hasVideo) {
    return false;
  }

  return (
    (probeSummary.videoWidth ?? 0) > MAX_TRANSCODE_VIDEO_WIDTH ||
    (probeSummary.videoHeight ?? 0) > MAX_TRANSCODE_VIDEO_HEIGHT
  );
};

const needsFrameRateCap = (
  probeSummary: TIptvSourceProbeSummary | undefined
): boolean => {
  if (!probeSummary?.hasVideo || probeSummary.videoFrameRate === undefined) {
    return false;
  }

  return probeSummary.videoFrameRate > MAX_TRANSCODE_VIDEO_FRAME_RATE + 0.01;
};

const needsDeinterlace = (
  probeSummary: TIptvSourceProbeSummary | undefined
): boolean => {
  const fieldOrder = probeSummary?.videoFieldOrder;

  if (!probeSummary?.hasVideo || !fieldOrder) {
    return false;
  }

  return fieldOrder !== 'progressive' && fieldOrder !== 'unknown';
};

const buildVideoFilter = (
  probeSummary: TIptvSourceProbeSummary | undefined
): string | undefined => {
  const filters: string[] = [];

  if (needsDeinterlace(probeSummary)) {
    filters.push('yadif=mode=send_frame:parity=auto:deint=all');
  }

  if (needsResolutionCap(probeSummary)) {
    filters.push(
      `scale=${MAX_TRANSCODE_VIDEO_WIDTH}:${MAX_TRANSCODE_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2`
    );
  }

  if (needsFrameRateCap(probeSummary)) {
    filters.push(`fps=${MAX_TRANSCODE_VIDEO_FRAME_RATE}`);
  }

  if (filters.length === 0) {
    return undefined;
  }

  return filters.join(',');
};

const resolveTranscodeVideoProfile = (): {
  crf: number;
  maxRateKbps: number;
  bufferSizeKbps: number;
} => {
  return {
    crf: TRANSCODE_VIDEO_CRF,
    maxRateKbps: TRANSCODE_VIDEO_MAX_RATE_KBPS,
    bufferSizeKbps: TRANSCODE_VIDEO_BUFFER_SIZE_KBPS
  };
};

const getStderrTail = (stderrOutput: string): string | undefined => {
  const lines = stderrOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  return lines.slice(-4).join(' | ');
};

let nextIptvSsrc = 1;

const allocateSsrc = (): number => {
  const ssrc = nextIptvSsrc;

  nextIptvSsrc += 1;

  if (nextIptvSsrc > MAX_SSRC) {
    nextIptvSsrc = 1;
  }

  return ssrc;
};

const getVideoRtpParameters = (ssrc: number): RtpParameters => {
  return {
    codecs: [
      {
        mimeType: 'video/H264',
        payloadType: VIDEO_PAYLOAD_TYPE,
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e02a',
          'level-asymmetry-allowed': 1
        },
        rtcpFeedback: [
          { type: 'nack' },
          { type: 'nack', parameter: 'pli' },
          { type: 'goog-remb' },
          { type: 'transport-cc' }
        ]
      }
    ],
    encodings: [{ ssrc }],
    rtcp: { cname: 'iptv-video' }
  };
};

const getAudioRtpParameters = (ssrc: number): RtpParameters => {
  return {
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: AUDIO_PAYLOAD_TYPE,
        clockRate: 48000,
        channels: 2,
        parameters: {
          useinbandfec: 1,
          usedtx: 1
        },
        rtcpFeedback: [{ type: 'transport-cc' }]
      }
    ],
    encodings: [{ ssrc }],
    rtcp: { cname: 'iptv-audio' }
  };
};

class IptvSession {
  public readonly channelId: number;
  private playlistUrl: string;
  private enabled: boolean;
  private alwaysTranscodeVideo: boolean;
  private destroyed = false;
  private readonly videoSsrc: number;
  private readonly audioSsrc: number;

  private status: TIptvStatus = { status: 'idle' };
  private activeChannel?: { index: number; name: string; logo?: string };
  private activeChannelIndex?: number;

  private ffmpegProcess?: ChildProcess;
  private ffmpegStderr = '';
  private usingVideoCopy = false;
  private forceVideoTranscode = false;
  private expectedStop = false;

  private videoTransport?: PlainTransport<AppData>;
  private audioTransport?: PlainTransport<AppData>;
  private videoProducer?: Producer<AppData>;
  private audioProducer?: Producer<AppData>;
  private externalStreamId?: number;

  private retryCount = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private lastTotalBytes = 0;
  private lastVideoBytes = 0;
  private lastAudioBytes = 0;
  private lastDataAt = 0;
  private lastVideoDataAt = 0;
  private noViewerSince = 0;
  private sourceProbeSummary?: TIptvSourceProbeSummary;
  private audioOnlyWarningLogged = false;
  private firstVideoPacketLogged = false;
  private firstAudioPacketLogged = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(channelId: number, config: TIptvSessionConfig) {
    this.channelId = channelId;
    this.playlistUrl = config.playlistUrl;
    this.enabled = config.enabled;
    this.alwaysTranscodeVideo = config.alwaysTranscodeVideo ?? false;
    this.activeChannelIndex = config.activeChannelIndex ?? undefined;
    this.videoSsrc = allocateSsrc();
    this.audioSsrc = allocateSsrc();
  }

  public updateConfig = (config: TIptvSessionConfig) => {
    this.playlistUrl = config.playlistUrl;
    this.enabled = config.enabled;
    this.alwaysTranscodeVideo = config.alwaysTranscodeVideo ?? false;

    if (config.activeChannelIndex !== undefined) {
      this.activeChannelIndex = config.activeChannelIndex ?? undefined;

      if (config.activeChannelIndex === null) {
        this.activeChannel = undefined;
      }
    }
  };

  public getStatus = (): TIptvStatus => {
    return this.status;
  };

  public listChannels = async (): Promise<TIptvChannel[]> => {
    return await fetchAndParsePlaylist(this.playlistUrl);
  };

  private resetHealthTracking = () => {
    const now = Date.now();

    this.lastTotalBytes = 0;
    this.lastVideoBytes = 0;
    this.lastAudioBytes = 0;
    this.lastDataAt = now;
    this.lastVideoDataAt = now;
    this.audioOnlyWarningLogged = false;
    this.firstVideoPacketLogged = false;
    this.firstAudioPacketLogged = false;
  };

  private logSourceProbe = (
    channelName: string,
    probeResult: TIptvSourceProbeResult
  ) => {
    const { summary: probeSummary, failureReason } = probeResult;

    if (!probeSummary) {
      logger.warn(
        '[IPTV %s] ffprobe could not inspect source streams for "%s"%s',
        this.channelId,
        channelName,
        failureReason ? `: ${failureReason}` : ''
      );
      return;
    }

    logger.info(
      '[IPTV %s] source probe for "%s": video=%s%s, audio=%s%s',
      this.channelId,
      channelName,
      formatCodecLabel(probeSummary.hasVideo, probeSummary.videoCodec, 'video'),
      probeSummary.hasVideo
        ? formatProbeDetails([
            formatResolutionLabel(
              probeSummary.videoWidth,
              probeSummary.videoHeight
            ),
            formatFrameRateLabel(probeSummary.videoFrameRate),
            formatBitrateLabel(probeSummary.videoBitrate)
          ])
        : '',
      formatCodecLabel(probeSummary.hasAudio, probeSummary.audioCodec, 'audio'),
      probeSummary.hasAudio
        ? formatProbeDetails([formatBitrateLabel(probeSummary.audioBitrate)])
        : ''
    );

    if (!probeSummary.hasVideo) {
      logger.warn(
        '[IPTV %s] source "%s" does not expose a video stream',
        this.channelId,
        channelName
      );
    }

    if (!probeSummary.hasAudio) {
      logger.warn(
        '[IPTV %s] source "%s" does not expose an audio stream',
        this.channelId,
        channelName
      );
    }
  };

  private logStreamDecision = (
    channelName: string,
    sourcePreparation: TIptvChannelPreparation
  ) => {
    const probeSummary = this.sourceProbeSummary;
    const decisionReasons: string[] = [];

    if (this.forceVideoTranscode) {
      decisionReasons.push('copy-mode fallback');
    }

    if (this.alwaysTranscodeVideo) {
      decisionReasons.push('video copy disabled by config');
    }

    if (!probeSummary) {
      decisionReasons.push('probe unavailable');
    } else {
      if (probeSummary.videoCodec && probeSummary.videoCodec !== 'h264') {
        decisionReasons.push(`codec=${probeSummary.videoCodec}`);
      }

      if (needsResolutionCap(probeSummary)) {
        decisionReasons.push('resolution cap');
      }

      if (needsFrameRateCap(probeSummary)) {
        decisionReasons.push('frame-rate cap');
      }

      if (needsDeinterlace(probeSummary)) {
        decisionReasons.push(`deinterlace=${probeSummary.videoFieldOrder}`);
      }
    }

    const mode = sourcePreparation.shouldTranscodeVideo ? 'transcode' : 'copy';
    const outputVideo = sourcePreparation.shouldTranscodeVideo
      ? `h264${formatProbeDetails([
          `preset=faster`,
          sourcePreparation.targetVideoCrf !== undefined
            ? `crf=${sourcePreparation.targetVideoCrf}`
            : undefined,
          sourcePreparation.videoFilter
            ? `filter=${sourcePreparation.videoFilter}`
            : 'filter=none',
          sourcePreparation.targetVideoMaxRateKbps
            ? `maxrate=${sourcePreparation.targetVideoMaxRateKbps}k`
            : undefined,
          sourcePreparation.targetVideoBufferSizeKbps
            ? `bufsize=${sourcePreparation.targetVideoBufferSizeKbps}k`
            : undefined
        ])}`
      : 'copy';
    const outputAudio = 'opus (bitrate=128k, channels=2, rate=48000)';

    logger.info(
      '[IPTV %s] stream decision for "%s": mode=%s%s, sourceVideo=%s, sourceAudio=%s, outputVideo=%s, outputAudio=%s',
      this.channelId,
      channelName,
      mode,
      decisionReasons.length > 0 ? ` (${decisionReasons.join(', ')})` : '',
      formatSourceVideoSummary(probeSummary),
      formatSourceAudioSummary(probeSummary),
      outputVideo,
      outputAudio
    );
  };

  private prepareChannelSource = async (
    channel: TIptvChannel
  ): Promise<TIptvChannelPreparation> => {
    await assertSafeIptvUrl(channel.url);

    const probeResult = await this.inspectSourceStreams(channel.url);
    const probeSummary = probeResult.summary;
    const transcodeVideoProfile = resolveTranscodeVideoProfile();
    const shouldTranscodeVideo =
      this.alwaysTranscodeVideo ||
      this.forceVideoTranscode ||
      !probeSummary ||
      probeSummary.videoCodec !== 'h264' ||
      needsResolutionCap(probeSummary) ||
      needsFrameRateCap(probeSummary) ||
      needsDeinterlace(probeSummary);

    this.sourceProbeSummary = probeSummary;
    this.logSourceProbe(channel.name, probeResult);

    const sourcePreparation: TIptvChannelPreparation = {
      shouldTranscodeVideo,
      videoFilter: buildVideoFilter(probeSummary),
      targetVideoCrf: transcodeVideoProfile.crf,
      targetVideoMaxRateKbps: transcodeVideoProfile.maxRateKbps,
      targetVideoBufferSizeKbps: transcodeVideoProfile.bufferSizeKbps,
      videoCodec: probeSummary?.videoCodec
    };

    this.logStreamDecision(channel.name, sourcePreparation);

    return sourcePreparation;
  };

  private inspectSourceStreams = async (
    streamUrl: string
  ): Promise<TIptvSourceProbeResult> => {
    return await inspectSourceStreams(streamUrl);
  };

  private enqueueLifecycle = async <T>(
    operation: () => Promise<T>
  ): Promise<T> => {
    const run = async () => {
      return await operation();
    };
    const next = this.lifecycleQueue.then(run, run);

    this.lifecycleQueue = next.then(
      () => undefined,
      () => undefined
    );

    return await next;
  };

  public startStream = async (channelIndex: number): Promise<TIptvStatus> => {
    return await this.enqueueLifecycle(async () => {
      if (this.destroyed) {
        throw new Error('IPTV session has been destroyed');
      }

      if (!this.enabled) {
        throw new Error('IPTV source is disabled');
      }

      await this.persistActiveChannelIndex(channelIndex);
      this.activeChannelIndex = channelIndex;
      this.retryCount = 0;
      this.forceVideoTranscode = false;

      await this.startSelectedChannelInternal();

      return this.status;
    });
  };

  public switchChannel = async (channelIndex: number): Promise<TIptvStatus> => {
    return await this.enqueueLifecycle(async () => {
      if (!this.enabled) {
        throw new Error('IPTV source is disabled');
      }

      await this.persistActiveChannelIndex(channelIndex);
      this.activeChannelIndex = channelIndex;
      this.retryCount = 0;
      this.forceVideoTranscode = false;

      await this.startSelectedChannelInternal();

      return this.status;
    });
  };

  public stopStream = async (options?: {
    publishIdle?: boolean;
    clearActiveChannel?: boolean;
  }) => {
    await this.enqueueLifecycle(async () => {
      await this.stopStreamInternal(options);
    });
  };

  public resumeIfPossible = async (): Promise<TIptvStatus> => {
    return await this.enqueueLifecycle(async () => {
      if (this.destroyed || !this.enabled) {
        return this.status;
      }

      if (
        this.status.status === 'starting' ||
        this.status.status === 'streaming'
      ) {
        return this.status;
      }

      if (this.activeChannelIndex === undefined) {
        return this.status;
      }

      const runtime = VoiceRuntime.findById(this.channelId);
      const viewerCount = runtime?.getState().users.length ?? 0;

      if (viewerCount === 0) {
        return this.status;
      }

      this.retryCount = 0;
      this.forceVideoTranscode = false;
      await this.startSelectedChannelInternal();

      return this.status;
    });
  };

  private persistActiveChannelIndex = async (
    activeChannelIndex: number | null
  ) => {
    await db
      .update(iptvSources)
      .set({
        activeChannelIndex,
        updatedAt: Date.now()
      })
      .where(eq(iptvSources.channelId, this.channelId))
      .run();
  };

  private clearPersistedActiveChannel = async () => {
    await this.persistActiveChannelIndex(null);

    this.activeChannel = undefined;
    this.activeChannelIndex = undefined;
    this.forceVideoTranscode = false;
  };

  public stopStreamAndClearSelection = async (options?: {
    publishIdle?: boolean;
  }) => {
    await this.enqueueLifecycle(async () => {
      await this.clearPersistedActiveChannel();
      await this.stopStreamInternal({
        publishIdle: options?.publishIdle,
        clearActiveChannel: false
      });
    });
  };

  private stopStreamInternal = async (options?: {
    publishIdle?: boolean;
    clearActiveChannel?: boolean;
  }) => {
    this.clearTimers();
    this.expectedStop = true;
    this.noViewerSince = 0;
    this.resetHealthTracking();

    try {
      await this.stopFfmpegProcess();
    } finally {
      this.ffmpegProcess = undefined;
      this.ffmpegStderr = '';
      this.sourceProbeSummary = undefined;

      if (this.videoProducer && !this.videoProducer.closed) {
        this.videoProducer.close();
      }

      if (this.audioProducer && !this.audioProducer.closed) {
        this.audioProducer.close();
      }

      if (this.videoTransport && !this.videoTransport.closed) {
        this.videoTransport.close();
      }

      if (this.audioTransport && !this.audioTransport.closed) {
        this.audioTransport.close();
      }

      this.videoProducer = undefined;
      this.audioProducer = undefined;
      this.videoTransport = undefined;
      this.audioTransport = undefined;

      const runtime = VoiceRuntime.findById(this.channelId);

      if (runtime && this.externalStreamId !== undefined) {
        runtime.removeExternalStream(this.externalStreamId);
      }

      this.externalStreamId = undefined;
    }

    if (options?.clearActiveChannel !== false) {
      this.activeChannel = undefined;
      this.activeChannelIndex = undefined;
      this.forceVideoTranscode = false;
    }

    if (options?.publishIdle !== false) {
      this.updateStatus({
        status: 'idle'
      });
    }
  };

  public destroy = async () => {
    await this.enqueueLifecycle(async () => {
      this.destroyed = true;
      await this.stopStreamInternal({
        publishIdle: true,
        clearActiveChannel: true
      });
    });
  };

  private startSelectedChannelInternal = async (): Promise<void> => {
    if (this.activeChannelIndex === undefined) {
      throw new Error('No active IPTV channel selected');
    }

    const channels = await this.listChannels();
    const channel = channels[this.activeChannelIndex];

    if (!channel) {
      throw new Error('IPTV channel index is out of range');
    }

    this.activeChannel = {
      index: this.activeChannelIndex,
      name: channel.name,
      logo: channel.logo
    };

    const sourcePreparation = await this.prepareChannelSource(channel);

    await this.stopStreamInternal({
      publishIdle: false,
      clearActiveChannel: false
    });
    this.expectedStop = false;

    this.updateStatus({
      status: 'starting',
      activeChannel: this.activeChannel
    });

    const runtime = VoiceRuntime.findById(this.channelId);

    if (!runtime) {
      throw new Error('Voice runtime not found');
    }

    let videoTransport: PlainTransport<AppData> | undefined;
    let audioTransport: PlainTransport<AppData> | undefined;
    let videoProducer: Producer<AppData> | undefined;
    let audioProducer: Producer<AppData> | undefined;
    let videoTuple: PlainTransport<AppData>['tuple'] | undefined;
    let videoRtcpTuple: PlainTransport<AppData>['rtcpTuple'] | undefined;
    let audioTuple: PlainTransport<AppData>['tuple'] | undefined;
    let audioRtcpTuple: PlainTransport<AppData>['rtcpTuple'] | undefined;

    try {
      videoTransport = await runtime.getRouter().createPlainTransport({
        listenInfo: {
          protocol: 'udp',
          ip: '127.0.0.1'
        },
        rtcpMux: false,
        comedia: true
      });
      audioTransport = await runtime.getRouter().createPlainTransport({
        listenInfo: {
          protocol: 'udp',
          ip: '127.0.0.1'
        },
        rtcpMux: false,
        comedia: true
      });
      videoTuple = videoTransport.tuple;
      videoRtcpTuple = videoTransport.rtcpTuple;
      audioTuple = audioTransport.tuple;
      audioRtcpTuple = audioTransport.rtcpTuple;

      if (!videoTuple || !videoRtcpTuple || !audioTuple || !audioRtcpTuple) {
        throw new Error('Failed to initialize plain transport tuples');
      }

      videoProducer = await videoTransport.produce({
        kind: 'video',
        rtpParameters: getVideoRtpParameters(this.videoSsrc)
      });
      audioProducer = await audioTransport.produce({
        kind: 'audio',
        rtpParameters: getAudioRtpParameters(this.audioSsrc)
      });
    } catch (error) {
      if (videoProducer && !videoProducer.closed) {
        videoProducer.close();
      }

      if (audioProducer && !audioProducer.closed) {
        audioProducer.close();
      }

      if (videoTransport && !videoTransport.closed) {
        videoTransport.close();
      }

      if (audioTransport && !audioTransport.closed) {
        audioTransport.close();
      }

      this.updateStatus({
        status: 'error',
        activeChannel: this.activeChannel,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to create stream resources'
      });

      throw error;
    }

    if (
      !videoTransport ||
      !audioTransport ||
      !videoProducer ||
      !audioProducer ||
      !videoTuple ||
      !videoRtcpTuple ||
      !audioTuple ||
      !audioRtcpTuple
    ) {
      throw new Error('Failed to initialize IPTV stream resources');
    }

    const streamId = runtime.createExternalStream({
      title: channel.name,
      key: `iptv:${this.channelId}`,
      pluginId: IPTV_PLUGIN_ID,
      avatarUrl: channel.logo,
      producers: {
        video: videoProducer,
        audio: audioProducer
      }
    });
    const stream = runtime.getState().externalStreams[streamId];

    if (stream) {
      pubsub.publish(ServerEvents.VOICE_ADD_EXTERNAL_STREAM, {
        channelId: this.channelId,
        streamId,
        stream
      });
    }

    pubsub.publishForChannel(this.channelId, ServerEvents.VOICE_NEW_PRODUCER, {
      channelId: this.channelId,
      remoteId: streamId,
      kind: StreamKind.EXTERNAL_VIDEO
    });
    pubsub.publishForChannel(this.channelId, ServerEvents.VOICE_NEW_PRODUCER, {
      channelId: this.channelId,
      remoteId: streamId,
      kind: StreamKind.EXTERNAL_AUDIO
    });

    this.videoTransport = videoTransport;
    this.audioTransport = audioTransport;
    this.videoProducer = videoProducer;
    this.audioProducer = audioProducer;
    this.externalStreamId = streamId;

    this.usingVideoCopy = !sourcePreparation.shouldTranscodeVideo;
    logger.info(
      '[IPTV %s] launching ffmpeg for "%s" (retry=%s, videoCopy=%s, videoCodec=%s, videoFilter=%s)',
      this.channelId,
      channel.name,
      this.retryCount,
      this.usingVideoCopy,
      sourcePreparation.videoCodec ?? 'unknown',
      sourcePreparation.videoFilter ?? 'none'
    );

    this.spawnFfmpeg({
      streamUrl: channel.url,
      videoRtpPort: videoTuple.localPort,
      videoRtcpPort: videoRtcpTuple.localPort,
      audioRtpPort: audioTuple.localPort,
      audioRtcpPort: audioRtcpTuple.localPort,
      transcodeVideo: sourcePreparation.shouldTranscodeVideo,
      videoFilter: sourcePreparation.videoFilter,
      targetVideoCrf: sourcePreparation.targetVideoCrf,
      targetVideoMaxRateKbps: sourcePreparation.targetVideoMaxRateKbps,
      targetVideoBufferSizeKbps: sourcePreparation.targetVideoBufferSizeKbps
    });

    this.resetHealthTracking();
    this.noViewerSince = 0;
    this.startHealthCheck();
    this.startStableTimer();
  };

  private restartFfmpegInternal = async (): Promise<void> => {
    if (this.activeChannelIndex === undefined) {
      throw new Error('No active IPTV channel selected');
    }

    if (
      !this.videoTransport ||
      !this.audioTransport ||
      !this.videoProducer ||
      !this.audioProducer ||
      this.externalStreamId === undefined
    ) {
      await this.startSelectedChannelInternal();
      return;
    }

    const channels = await this.listChannels();
    const channel = channels[this.activeChannelIndex];

    if (!channel) {
      throw new Error('IPTV channel index is out of range');
    }

    this.activeChannel = {
      index: this.activeChannelIndex,
      name: channel.name,
      logo: channel.logo
    };

    const runtime = VoiceRuntime.findById(this.channelId);

    if (!runtime) {
      throw new Error('Voice runtime not found');
    }

    const videoTuple = this.videoTransport.tuple;
    const videoRtcpTuple = this.videoTransport.rtcpTuple;
    const audioTuple = this.audioTransport.tuple;
    const audioRtcpTuple = this.audioTransport.rtcpTuple;

    if (!videoTuple || !videoRtcpTuple || !audioTuple || !audioRtcpTuple) {
      throw new Error('Failed to initialize plain transport tuples');
    }

    const sourcePreparation = await this.prepareChannelSource(channel);

    runtime.updateExternalStream(this.externalStreamId, {
      title: channel.name,
      avatarUrl: channel.logo
    });

    this.usingVideoCopy = !sourcePreparation.shouldTranscodeVideo;
    this.expectedStop = true;

    try {
      await this.stopFfmpegProcess();
    } finally {
      this.expectedStop = false;
      this.ffmpegProcess = undefined;
      this.ffmpegStderr = '';
    }
    logger.info(
      '[IPTV %s] relaunching ffmpeg for "%s" (retry=%s, videoCopy=%s, videoCodec=%s, videoFilter=%s)',
      this.channelId,
      channel.name,
      this.retryCount,
      this.usingVideoCopy,
      sourcePreparation.videoCodec ?? 'unknown',
      sourcePreparation.videoFilter ?? 'none'
    );

    this.spawnFfmpeg({
      streamUrl: channel.url,
      videoRtpPort: videoTuple.localPort,
      videoRtcpPort: videoRtcpTuple.localPort,
      audioRtpPort: audioTuple.localPort,
      audioRtcpPort: audioRtcpTuple.localPort,
      transcodeVideo: sourcePreparation.shouldTranscodeVideo,
      videoFilter: sourcePreparation.videoFilter,
      targetVideoCrf: sourcePreparation.targetVideoCrf,
      targetVideoMaxRateKbps: sourcePreparation.targetVideoMaxRateKbps,
      targetVideoBufferSizeKbps: sourcePreparation.targetVideoBufferSizeKbps
    });

    this.resetHealthTracking();
    this.noViewerSince = 0;
    this.startHealthCheck();
    this.startStableTimer();
  };

  private waitForProcessExit = async (
    process: ChildProcess,
    timeoutMs: number
  ): Promise<void> => {
    await new Promise<void>((resolve) => {
      let finished = false;

      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timeout);
        process.off('exit', onExit);
        process.off('close', onClose);
        resolve();
      };
      const onExit = () => {
        finish();
      };
      const onClose = () => {
        finish();
      };
      const timeout = setTimeout(() => {
        finish();
      }, timeoutMs);

      process.once('exit', onExit);
      process.once('close', onClose);
    });
  };

  private stopFfmpegProcess = async (): Promise<void> => {
    const process = this.ffmpegProcess;

    if (!process || process.exitCode !== null) {
      return;
    }

    process.kill('SIGTERM');
    await this.waitForProcessExit(process, FFMPEG_EXIT_GRACE_MS);

    if (process.exitCode !== null) {
      return;
    }

    process.kill('SIGKILL');
    await this.waitForProcessExit(process, FFMPEG_EXIT_KILL_MS);

    if (process.exitCode === null) {
      throw new Error('Timed out waiting for ffmpeg to stop');
    }
  };

  private spawnFfmpeg = (options: {
    streamUrl: string;
    videoRtpPort: number;
    videoRtcpPort: number;
    audioRtpPort: number;
    audioRtcpPort: number;
    transcodeVideo: boolean;
    videoFilter?: string;
    targetVideoCrf?: number;
    targetVideoMaxRateKbps?: number;
    targetVideoBufferSizeKbps?: number;
  }) => {
    const videoCodecArgs = options.transcodeVideo
      ? [
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-profile:v',
          'baseline',
          '-level:v',
          '4.2',
          '-preset',
          'faster',
          '-bf:v',
          '0',
          '-crf',
          String(options.targetVideoCrf ?? TRANSCODE_VIDEO_CRF),
          '-maxrate',
          `${options.targetVideoMaxRateKbps ?? TRANSCODE_VIDEO_MAX_RATE_KBPS}k`,
          '-bufsize',
          `${options.targetVideoBufferSizeKbps ?? TRANSCODE_VIDEO_BUFFER_SIZE_KBPS}k`
        ]
      : ['-c:v', 'copy'];
    const videoFilterArgs =
      options.transcodeVideo && options.videoFilter
        ? ['-vf', options.videoFilter]
        : [];
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-re',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      options.streamUrl,
      '-map',
      '0:v:0?',
      ...videoCodecArgs,
      ...videoFilterArgs,
      '-f',
      'rtp',
      '-ssrc',
      String(this.videoSsrc),
      '-payload_type',
      String(VIDEO_PAYLOAD_TYPE),
      `rtp://127.0.0.1:${options.videoRtpPort}?rtcpport=${options.videoRtcpPort}`,
      '-map',
      '0:a:0?',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-f',
      'rtp',
      '-ssrc',
      String(this.audioSsrc),
      '-payload_type',
      String(AUDIO_PAYLOAD_TYPE),
      `rtp://127.0.0.1:${options.audioRtpPort}?rtcpport=${options.audioRtcpPort}`
    ];
    const process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    this.ffmpegProcess = process;
    this.ffmpegStderr = '';

    process.stderr?.on('data', (chunk) => {
      this.ffmpegStderr += chunk.toString();

      if (this.ffmpegStderr.length > 10_000) {
        this.ffmpegStderr = this.ffmpegStderr.slice(-10_000);
      }
    });

    process.on('error', (error: Error) => {
      logger.error(
        '[IPTV %s] ffmpeg spawn error: %s',
        this.channelId,
        error.message
      );
    });

    process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      void this.handleUnexpectedExit(code, signal, this.ffmpegStderr);
    });
  };

  private handleUnexpectedExit = async (
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrOutput: string
  ) => {
    this.ffmpegProcess = undefined;

    if (this.expectedStop || this.destroyed) {
      return;
    }

    const stderrTail = getStderrTail(stderrOutput);

    logger.warn(
      '[IPTV %s] ffmpeg exited unexpectedly (code=%s signal=%s%s)',
      this.channelId,
      code,
      signal,
      stderrTail ? ` stderr=${stderrTail}` : ''
    );

    if (this.usingVideoCopy && isVideoCopyFailure(stderrOutput)) {
      logger.warn(
        '[IPTV %s] ffmpeg copy mode failed, retrying with H264 transcode',
        this.channelId
      );
      this.forceVideoTranscode = true;
      this.retryCount = 0;
      try {
        await this.scheduleRestart(0);
      } catch (error) {
        this.logScheduleRestartError(
          'scheduleRestart threw during unexpected exit copy-mode recovery',
          error
        );
      }
      return;
    }

    try {
      await this.scheduleRestart();
    } catch (error) {
      this.logScheduleRestartError(
        'scheduleRestart threw during unexpected exit handling',
        error
      );
    }
  };

  private logScheduleRestartError = (context: string, error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown IPTV restart scheduling error';

    logger.error('[IPTV %s] %s: %s', this.channelId, context, message);
  };

  private scheduleRestart = async (delayMs?: number) => {
    await this.enqueueLifecycle(async () => {
      if (this.destroyed || this.activeChannelIndex === undefined) {
        return;
      }
      this.clearTimers();
      this.noViewerSince = 0;

      if (this.retryCount >= MAX_RETRIES) {
        await this.stopStreamInternal({
          publishIdle: false,
          clearActiveChannel: false
        });
        this.updateStatus({
          status: 'error',
          activeChannel: this.activeChannel,
          error: 'IPTV stream failed after multiple retry attempts'
        });
        return;
      }

      const retryDelay =
        delayMs ??
        RETRY_DELAYS_MS[
          Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)
        ] ??
        RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      this.retryCount += 1;
      logger.warn(
        '[IPTV %s] scheduling restart attempt %s/%s in %sms',
        this.channelId,
        this.retryCount,
        MAX_RETRIES,
        retryDelay
      );
      this.updateStatus({
        status: 'starting',
        activeChannel: this.activeChannel
      });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.enqueueLifecycle(async () => {
          try {
            await this.restartFfmpegInternal();
          } catch (error: unknown) {
            const message =
              error instanceof Error
                ? error.message
                : 'Unknown IPTV restart error';

            logger.error(
              '[IPTV %s] restart failed: %s',
              this.channelId,
              message
            );

            try {
              await this.scheduleRestart();
            } catch (scheduleRestartError) {
              this.logScheduleRestartError(
                'scheduleRestart threw after restart failure',
                scheduleRestartError
              );
            }
          }
        });
      }, retryDelay);
    });
  };

  private startStableTimer = () => {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
    }

    this.stableTimer = setTimeout(() => {
      this.retryCount = 0;
    }, STABLE_STREAM_MS);
  };

  private startHealthCheck = () => {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    this.healthTimer = setInterval(() => {
      void this.runHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  };

  private runHealthCheck = async () => {
    if (
      (this.status.status !== 'starting' &&
        this.status.status !== 'streaming') ||
      !this.videoProducer ||
      !this.audioProducer
    ) {
      return;
    }

    const runtime = VoiceRuntime.findById(this.channelId);
    const viewerCount = runtime?.getState().users.length ?? 0;

    if (viewerCount === 0) {
      if (!this.noViewerSince) {
        this.noViewerSince = Date.now();
      }

      if (Date.now() - this.noViewerSince >= AUTO_STOP_NO_VIEWERS_MS) {
        logger.info(
          '[IPTV %s] stopping stream because there are no viewers',
          this.channelId
        );

        try {
          await this.clearPersistedActiveChannel();
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Unknown IPTV state clear error';

          logger.warn(
            '[IPTV %s] failed to clear persisted channel after idle stop: %s',
            this.channelId,
            message
          );
        }

        await this.stopStream({
          publishIdle: true,
          clearActiveChannel: true
        });
      }

      return;
    }

    this.noViewerSince = 0;

    try {
      const [videoStats, audioStats] = await Promise.all([
        this.videoProducer.getStats(),
        this.audioProducer.getStats()
      ]);
      const now = Date.now();
      const videoBytes = extractByteCount(videoStats);
      const audioBytes = extractByteCount(audioStats);
      const totalBytes = videoBytes + audioBytes;
      const hasNewVideoData = videoBytes > this.lastVideoBytes;
      const hasNewAudioData = audioBytes > this.lastAudioBytes;
      const startupLatencyMs = now - this.lastDataAt;

      if (hasNewVideoData) {
        if (!this.firstVideoPacketLogged) {
          logger.info(
            '[IPTV %s] first video packets received for "%s" after %sms (videoBytes=%s)',
            this.channelId,
            this.activeChannel?.name ?? 'unknown channel',
            startupLatencyMs,
            videoBytes
          );
          this.firstVideoPacketLogged = true;
        }

        this.lastVideoBytes = videoBytes;
        this.lastVideoDataAt = now;
        this.audioOnlyWarningLogged = false;
      }

      if (hasNewAudioData) {
        if (!this.firstAudioPacketLogged) {
          logger.info(
            '[IPTV %s] first audio packets received for "%s" after %sms (audioBytes=%s)',
            this.channelId,
            this.activeChannel?.name ?? 'unknown channel',
            startupLatencyMs,
            audioBytes
          );
          this.firstAudioPacketLogged = true;
        }

        this.lastAudioBytes = audioBytes;
      }

      if (totalBytes > this.lastTotalBytes) {
        if (this.status.status === 'starting') {
          const canPromoteToStreaming =
            hasNewVideoData ||
            (this.sourceProbeSummary?.hasVideo === false && hasNewAudioData);

          if (canPromoteToStreaming) {
            logger.info(
              '[IPTV %s] first media received for "%s" after %sms; stream is now live (videoBytes=%s audioBytes=%s)',
              this.channelId,
              this.activeChannel?.name ?? 'unknown channel',
              startupLatencyMs,
              videoBytes,
              audioBytes
            );
            this.updateStatus({
              status: 'streaming',
              activeChannel: this.activeChannel
            });
          }
        }

        this.lastTotalBytes = totalBytes;
        this.lastDataAt = now;
      }

      if (
        hasNewAudioData &&
        !hasNewVideoData &&
        !this.audioOnlyWarningLogged &&
        now - this.lastVideoDataAt > HEALTH_TIMEOUT_MS &&
        this.sourceProbeSummary?.hasVideo !== false
      ) {
        logger.warn(
          '[IPTV %s] audio packets are flowing without video packets for "%s" (videoBytes=%s audioBytes=%s, lastVideoMsAgo=%s)',
          this.channelId,
          this.activeChannel?.name ?? 'unknown channel',
          videoBytes,
          audioBytes,
          now - this.lastVideoDataAt
        );
        this.audioOnlyWarningLogged = true;
      }

      if (now - this.lastDataAt > HEALTH_TIMEOUT_MS) {
        logger.warn(
          '[IPTV %s] health check detected no data, restarting stream (videoBytes=%s audioBytes=%s)',
          this.channelId,
          videoBytes,
          audioBytes
        );
        await this.scheduleRestart();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown IPTV health error';
      logger.warn('[IPTV %s] health check failed: %s', this.channelId, message);
    }
  };

  private clearTimers = () => {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }

    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  };

  private updateStatus = (nextStatus: TIptvStatus) => {
    this.status = nextStatus;

    pubsub.publishForChannel(this.channelId, ServerEvents.IPTV_STATUS_CHANGE, {
      channelId: this.channelId,
      ...nextStatus
    });
  };
}

const iptvSessions = new Map<number, IptvSession>();

const getIptvSession = (channelId: number): IptvSession | undefined => {
  return iptvSessions.get(channelId);
};

const upsertIptvSession = (
  channelId: number,
  config: TIptvSessionConfig
): IptvSession => {
  const existing = iptvSessions.get(channelId);

  if (existing) {
    existing.updateConfig(config);
    return existing;
  }

  const session = new IptvSession(channelId, config);
  iptvSessions.set(channelId, session);

  return session;
};

const removeIptvSession = async (channelId: number): Promise<void> => {
  const session = iptvSessions.get(channelId);

  if (!session) {
    return;
  }

  iptvSessions.delete(channelId);
  await session.destroy();
};

const getIptvStatus = (channelId: number): TIptvStatus => {
  const session = iptvSessions.get(channelId);

  if (!session) {
    return { status: 'idle' };
  }

  return session.getStatus();
};

eventBus.on('voice:runtime_closed', ({ channelId }) => {
  void removeIptvSession(channelId);
});

export {
  getIptvSession,
  getIptvStatus,
  IPTV_PLUGIN_ID,
  IptvSession,
  removeIptvSession,
  upsertIptvSession
};
