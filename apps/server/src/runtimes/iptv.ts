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
const VIDEO_SSRC = 1111;
const AUDIO_SSRC = 2222;
const VIDEO_PAYLOAD_TYPE = 96;
const AUDIO_PAYLOAD_TYPE = 97;
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const STABLE_STREAM_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 10_000;
const AUTO_STOP_NO_VIEWERS_MS = 15_000;
const FFPROBE_TIMEOUT_MS = 5000;
const FFMPEG_EXIT_GRACE_MS = 1500;
const FFMPEG_EXIT_KILL_MS = 1000;

type TIptvSessionConfig = {
  playlistUrl: string;
  enabled: boolean;
  activeChannelIndex?: number | null;
};

type TRecordValue = Record<string, unknown>;

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

  return (
    normalized.includes('error while opening encoder') ||
    normalized.includes('could not find tag for codec') ||
    normalized.includes('could not write header') ||
    normalized.includes('h264') ||
    normalized.includes('bitstream')
  );
};

const detectVideoCodec = async (
  streamUrl: string
): Promise<string | undefined> => {
  return await new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      streamUrl
    ];
    const ffprobe = spawn('ffprobe', args, {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    let resolved = false;

    const finish = (codec: string | undefined) => {
      if (resolved) {
        return;
      }

      resolved = true;
      resolve(codec);
    };

    const timeout = setTimeout(() => {
      ffprobe.kill('SIGKILL');
      finish(undefined);
    }, FFPROBE_TIMEOUT_MS);

    ffprobe.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });

    ffprobe.on('error', () => {
      clearTimeout(timeout);
      finish(undefined);
    });

    ffprobe.on('close', (code: number | null) => {
      clearTimeout(timeout);

      if (code !== 0) {
        finish(undefined);
        return;
      }

      const codec = output.trim().toLowerCase();
      finish(codec || undefined);
    });
  });
};

const getVideoRtpParameters = (): RtpParameters => {
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
    encodings: [{ ssrc: VIDEO_SSRC }],
    rtcp: { cname: 'iptv-video' }
  };
};

const getAudioRtpParameters = (): RtpParameters => {
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
    encodings: [{ ssrc: AUDIO_SSRC }],
    rtcp: { cname: 'iptv-audio' }
  };
};

class IptvSession {
  public readonly channelId: number;
  private playlistUrl: string;
  private enabled: boolean;
  private destroyed = false;

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
  private lastDataAt = 0;
  private noViewerSince = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(channelId: number, config: TIptvSessionConfig) {
    this.channelId = channelId;
    this.playlistUrl = config.playlistUrl;
    this.enabled = config.enabled;
    this.activeChannelIndex = config.activeChannelIndex ?? undefined;
  }

  public updateConfig = (config: TIptvSessionConfig) => {
    this.playlistUrl = config.playlistUrl;
    this.enabled = config.enabled;

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

  private clearPersistedActiveChannel = async () => {
    this.activeChannel = undefined;
    this.activeChannelIndex = undefined;
    this.forceVideoTranscode = false;

    await db
      .update(iptvSources)
      .set({
        activeChannelIndex: null,
        updatedAt: Date.now()
      })
      .where(eq(iptvSources.channelId, this.channelId))
      .run();
  };

  private stopStreamInternal = async (options?: {
    publishIdle?: boolean;
    clearActiveChannel?: boolean;
  }) => {
    this.clearTimers();
    this.expectedStop = true;
    this.noViewerSince = 0;

    await this.stopFfmpegProcess();

    this.ffmpegProcess = undefined;
    this.ffmpegStderr = '';

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

    const videoTransport = await runtime.getRouter().createPlainTransport({
      listenInfo: {
        protocol: 'udp',
        ip: '127.0.0.1'
      },
      rtcpMux: false,
      comedia: true
    });
    const audioTransport = await runtime.getRouter().createPlainTransport({
      listenInfo: {
        protocol: 'udp',
        ip: '127.0.0.1'
      },
      rtcpMux: false,
      comedia: true
    });
    const videoTuple = videoTransport.tuple;
    const videoRtcpTuple = videoTransport.rtcpTuple;
    const audioTuple = audioTransport.tuple;
    const audioRtcpTuple = audioTransport.rtcpTuple;

    if (!videoTuple || !videoRtcpTuple || !audioTuple || !audioRtcpTuple) {
      videoTransport.close();
      audioTransport.close();
      throw new Error('Failed to initialize plain transport tuples');
    }

    const videoProducer = await videoTransport.produce({
      kind: 'video',
      rtpParameters: getVideoRtpParameters()
    });
    const audioProducer = await audioTransport.produce({
      kind: 'audio',
      rtpParameters: getAudioRtpParameters()
    });

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

    await assertSafeIptvUrl(channel.url);

    const codec = await detectVideoCodec(channel.url);
    const shouldTranscodeVideo =
      this.forceVideoTranscode || (!!codec && codec !== 'h264');

    this.usingVideoCopy = !shouldTranscodeVideo;

    this.spawnFfmpeg({
      streamUrl: channel.url,
      videoRtpPort: videoTuple.localPort,
      videoRtcpPort: videoRtcpTuple.localPort,
      audioRtpPort: audioTuple.localPort,
      audioRtcpPort: audioRtcpTuple.localPort,
      transcodeVideo: shouldTranscodeVideo
    });

    this.lastTotalBytes = 0;
    this.lastDataAt = Date.now();
    this.noViewerSince = 0;
    this.startHealthCheck();
    this.startStableTimer();

    this.updateStatus({
      status: 'streaming',
      activeChannel: this.activeChannel
    });
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
  }) => {
    const videoCodecArgs = options.transcodeVideo
      ? [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-tune',
          'zerolatency',
          '-b:v',
          '4000k'
        ]
      : ['-c:v', 'copy'];
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
      '-f',
      'rtp',
      '-ssrc',
      String(VIDEO_SSRC),
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
      String(AUDIO_SSRC),
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

    logger.warn(
      '[IPTV %s] ffmpeg exited unexpectedly (code=%s signal=%s)',
      this.channelId,
      code,
      signal
    );

    if (this.usingVideoCopy && isVideoCopyFailure(stderrOutput)) {
      logger.warn(
        '[IPTV %s] ffmpeg copy mode failed, retrying with H264 transcode',
        this.channelId
      );
      this.forceVideoTranscode = true;
      this.retryCount = 0;
      await this.scheduleRestart(0);
      return;
    }

    await this.scheduleRestart();
  };

  private scheduleRestart = async (delayMs?: number) => {
    await this.enqueueLifecycle(async () => {
      if (this.destroyed || this.activeChannelIndex === undefined) {
        return;
      }

      await this.stopStreamInternal({
        publishIdle: false,
        clearActiveChannel: false
      });

      if (this.retryCount >= MAX_RETRIES) {
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
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.enqueueLifecycle(async () => {
          try {
            await this.startSelectedChannelInternal();
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

            void this.scheduleRestart();
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
      this.status.status !== 'streaming' ||
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
      const totalBytes =
        extractByteCount(videoStats) + extractByteCount(audioStats);

      if (totalBytes > this.lastTotalBytes) {
        this.lastTotalBytes = totalBytes;
        this.lastDataAt = Date.now();
        return;
      }

      if (Date.now() - this.lastDataAt > HEALTH_TIMEOUT_MS) {
        logger.warn(
          '[IPTV %s] health check detected no data, restarting stream',
          this.channelId
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

    pubsub.publish(ServerEvents.IPTV_STATUS_CHANGE, {
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
