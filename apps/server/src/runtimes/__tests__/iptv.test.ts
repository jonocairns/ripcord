import type { TIptvChannel } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { IptvSession } from '../iptv';
import { VoiceRuntime } from '../voice';

const getPrepareChannelSource = (session: IptvSession) => {
  return Reflect.get(session, 'prepareChannelSource') as (
    channel: TIptvChannel
  ) => Promise<{
    shouldTranscodeVideo: boolean;
    videoCodec?: string;
    videoFilter?: string;
    targetVideoCrf?: number;
    targetVideoMaxRateKbps?: number;
    targetVideoBufferSizeKbps?: number;
  }>;
};

const getStopStreamInternal = (session: IptvSession) => {
  return Reflect.get(session, 'stopStreamInternal') as (options?: {
    publishIdle?: boolean;
    clearActiveChannel?: boolean;
  }) => Promise<void>;
};

const getRunHealthCheck = (session: IptvSession) => {
  return Reflect.get(session, 'runHealthCheck') as () => Promise<void>;
};

const getStartSelectedChannelInternal = (session: IptvSession) => {
  return Reflect.get(session, 'startSelectedChannelInternal') as () => Promise<void>;
};

const getRestartFfmpegInternal = (session: IptvSession) => {
  return Reflect.get(session, 'restartFfmpegInternal') as () => Promise<void>;
};

describe('IptvSession', () => {
  test('fails URL re-check before starting a stream', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });

    Reflect.set(session, 'listChannels', async (): Promise<TIptvChannel[]> => {
      return [
        {
          name: 'Unsafe News',
          url: 'http://127.0.0.1/private.m3u8'
        }
      ];
    });

    await expect(session.startStream(0)).rejects.toThrow(
      'Private or special IP addresses are not allowed'
    );
    expect(session.getStatus()).toEqual({ status: 'idle' });
  });

  test('transcodes video when ffprobe cannot inspect the source stream', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{ failureReason: string }> => {
        return {
          failureReason: 'probe failed'
        };
      }
    );

    const result = await prepareChannelSource.call(session, {
      name: 'News 24',
      url: 'https://8.8.8.8/news.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: true,
      videoCodec: undefined,
      videoFilter: undefined,
      targetVideoCrf: 18,
      targetVideoMaxRateKbps: 20_000,
      targetVideoBufferSizeKbps: 40_000
    });
  });

  test('keeps copy mode for in-cap h264 sources by default', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: {
          hasVideo: boolean;
          hasAudio: boolean;
          videoCodec: string;
          videoFieldOrder?: string;
          videoWidth: number;
          videoHeight: number;
          videoFrameRate: number;
        };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'h264',
            videoFieldOrder: 'progressive',
            videoWidth: 1280,
            videoHeight: 720,
            videoFrameRate: 50
          }
        };
      }
    );

    const result = await prepareChannelSource.call(session, {
      name: 'News 24',
      url: 'https://8.8.8.8/news.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: false,
      videoCodec: 'h264',
      videoFilter: undefined,
      targetVideoCrf: 18,
      targetVideoMaxRateKbps: 20_000,
      targetVideoBufferSizeKbps: 40_000
    });
  });

  test('transcodes in-cap h264 sources when alwaysTranscodeVideo is enabled', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true,
      alwaysTranscodeVideo: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: {
          hasVideo: boolean;
          hasAudio: boolean;
          videoCodec: string;
          videoFieldOrder?: string;
          videoWidth: number;
          videoHeight: number;
          videoFrameRate: number;
        };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'h264',
            videoFieldOrder: 'progressive',
            videoWidth: 1280,
            videoHeight: 720,
            videoFrameRate: 50
          }
        };
      }
    );

    const result = await prepareChannelSource.call(session, {
      name: 'News 24',
      url: 'https://8.8.8.8/news.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: true,
      videoCodec: 'h264',
      videoFilter: undefined,
      targetVideoCrf: 18,
      targetVideoMaxRateKbps: 20_000,
      targetVideoBufferSizeKbps: 40_000
    });
  });

  test('uses a CRF profile with a safety ceiling for 720p30 transcodes', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: {
          hasVideo: boolean;
          hasAudio: boolean;
          videoCodec: string;
          videoFieldOrder?: string;
          videoWidth: number;
          videoHeight: number;
          videoFrameRate: number;
        };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'mpeg2video',
            videoFieldOrder: 'progressive',
            videoWidth: 1280,
            videoHeight: 720,
            videoFrameRate: 30
          }
        };
      }
    );

    const result = await prepareChannelSource.call(session, {
      name: 'News HD',
      url: 'https://8.8.8.8/news.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: true,
      videoCodec: 'mpeg2video',
      videoFilter: undefined,
      targetVideoCrf: 18,
      targetVideoMaxRateKbps: 20_000,
      targetVideoBufferSizeKbps: 40_000
    });
  });

  test('transcodes high-resolution high-frame-rate h264 sources to the configured caps', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: {
          hasVideo: boolean;
          hasAudio: boolean;
          videoCodec: string;
          videoFieldOrder?: string;
          videoWidth: number;
          videoHeight: number;
          videoFrameRate: number;
        };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'h264',
            videoFieldOrder: 'progressive',
            videoWidth: 3840,
            videoHeight: 2160,
            videoFrameRate: 59.94
          }
        };
      }
    );

    const result = await prepareChannelSource.call(session, {
      name: 'Sports UHD',
      url: 'https://8.8.8.8/sports.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: true,
      videoCodec: 'h264',
      videoFilter:
        'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=50',
      targetVideoCrf: 18,
      targetVideoMaxRateKbps: 20_000,
      targetVideoBufferSizeKbps: 40_000
    });
  });

  test('adds deinterlacing when the probe reports an interlaced source', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: {
          hasVideo: boolean;
          hasAudio: boolean;
          videoCodec: string;
          videoFieldOrder: string;
          videoWidth: number;
          videoHeight: number;
          videoFrameRate: number;
        };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'mpeg2video',
            videoFieldOrder: 'tt',
            videoWidth: 1920,
            videoHeight: 1080,
            videoFrameRate: 25
          }
        };
      }
    );

    const result = await prepareChannelSource.call(session, {
      name: 'Broadcast Feed',
      url: 'https://8.8.8.8/broadcast.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: true,
      videoCodec: 'mpeg2video',
      videoFilter: 'yadif=mode=send_frame:parity=auto:deint=all',
      targetVideoCrf: 18,
      targetVideoMaxRateKbps: 20_000,
      targetVideoBufferSizeKbps: 40_000
    });
  });

  test('stores enriched probe metadata for later runtime decisions', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: {
          hasVideo: boolean;
          hasAudio: boolean;
          videoCodec: string;
          audioCodec: string;
          videoFieldOrder?: string;
          videoWidth: number;
          videoHeight: number;
          videoFrameRate: number;
          videoBitrate: number;
          audioBitrate: number;
        };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'h264',
            audioCodec: 'aac',
            videoFieldOrder: 'progressive',
            videoWidth: 1920,
            videoHeight: 1080,
            videoFrameRate: 50,
            videoBitrate: 8_000_000,
            audioBitrate: 192_000
          }
        };
      }
    );

    await prepareChannelSource.call(session, {
      name: 'Sports HD',
      url: 'https://8.8.8.8/sports.m3u8'
    });

    expect(Reflect.get(session, 'sourceProbeSummary')).toEqual({
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      videoFieldOrder: 'progressive',
      videoWidth: 1920,
      videoHeight: 1080,
      videoFrameRate: 50,
      videoBitrate: 8_000_000,
      audioBitrate: 192_000
    });
  });

  test('promotes starting IPTV streams to streaming after first video packets arrive', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const runHealthCheck = getRunHealthCheck(session);

    Reflect.set(session, 'status', {
      status: 'starting',
      activeChannel: {
        index: 0,
        name: 'Sports HD'
      }
    });
    Reflect.set(session, 'activeChannel', {
      index: 0,
      name: 'Sports HD'
    });
    Reflect.set(session, 'sourceProbeSummary', {
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac'
    });
    Reflect.set(session, 'lastDataAt', Date.now() - 500);
    Reflect.set(session, 'lastVideoDataAt', Date.now() - 500);
    Reflect.set(session, 'videoProducer', {
      getStats: async () => [{ byteCount: 4096 }]
    });
    Reflect.set(session, 'audioProducer', {
      getStats: async () => [{ byteCount: 512 }]
    });

    const originalFindById = VoiceRuntime.findById;
    VoiceRuntime.findById = ((_) => {
      return {
        getState: () => ({
          users: [{ id: 1 }]
        })
      } as unknown as VoiceRuntime;
    }) as typeof VoiceRuntime.findById;

    try {
      await runHealthCheck.call(session);
    } finally {
      VoiceRuntime.findById = originalFindById;
    }

    expect(session.getStatus()).toEqual({
      status: 'streaming',
      activeChannel: {
        index: 0,
        name: 'Sports HD'
      }
    });
  });

  test('cleans up transports and external stream when ffmpeg shutdown throws', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const stopStreamInternal = getStopStreamInternal(session);
    const stopError = new Error('Timed out waiting for ffmpeg to stop');

    const videoProducer = {
      closed: false,
      close() {
        this.closed = true;
      }
    };
    const audioProducer = {
      closed: false,
      close() {
        this.closed = true;
      }
    };
    const videoTransport = {
      closed: false,
      close() {
        this.closed = true;
      }
    };
    const audioTransport = {
      closed: false,
      close() {
        this.closed = true;
      }
    };

    Reflect.set(session, 'stopFfmpegProcess', async () => {
      throw stopError;
    });
    Reflect.set(session, 'videoProducer', videoProducer);
    Reflect.set(session, 'audioProducer', audioProducer);
    Reflect.set(session, 'videoTransport', videoTransport);
    Reflect.set(session, 'audioTransport', audioTransport);
    Reflect.set(session, 'externalStreamId', 123);
    Reflect.set(session, 'ffmpegStderr', 'ffmpeg stderr');
    Reflect.set(session, 'sourceProbeSummary', {
      hasVideo: true,
      hasAudio: true
    });

    const removedStreamIds: number[] = [];
    const originalFindById = VoiceRuntime.findById;
    VoiceRuntime.findById = ((_) => {
      return {
        removeExternalStream: (streamId: number) => {
          removedStreamIds.push(streamId);
        }
      } as unknown as VoiceRuntime;
    }) as typeof VoiceRuntime.findById;

    try {
      await expect(
        stopStreamInternal.call(session, { publishIdle: false })
      ).rejects.toThrow(stopError.message);
    } finally {
      VoiceRuntime.findById = originalFindById;
    }

    expect(videoProducer.closed).toBe(true);
    expect(audioProducer.closed).toBe(true);
    expect(videoTransport.closed).toBe(true);
    expect(audioTransport.closed).toBe(true);
    expect(removedStreamIds).toEqual([123]);
    expect(Reflect.get(session, 'videoProducer')).toBeUndefined();
    expect(Reflect.get(session, 'audioProducer')).toBeUndefined();
    expect(Reflect.get(session, 'videoTransport')).toBeUndefined();
    expect(Reflect.get(session, 'audioTransport')).toBeUndefined();
    expect(Reflect.get(session, 'externalStreamId')).toBeUndefined();
    expect(Reflect.get(session, 'ffmpegProcess')).toBeUndefined();
    expect(Reflect.get(session, 'ffmpegStderr')).toBe('');
    expect(Reflect.get(session, 'sourceProbeSummary')).toBeUndefined();
  });

  test('closes partially created mediasoup resources when producer setup fails', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const startSelectedChannelInternal = getStartSelectedChannelInternal(session);
    const produceError = new Error('audio producer failed');

    const videoProducer = {
      closed: false,
      close() {
        this.closed = true;
      }
    };
    const videoTransport = {
      closed: false,
      tuple: { localPort: 5004 },
      rtcpTuple: { localPort: 5005 },
      close() {
        this.closed = true;
      },
      produce: async () => {
        return videoProducer;
      }
    };
    const audioTransport = {
      closed: false,
      tuple: { localPort: 5006 },
      rtcpTuple: { localPort: 5007 },
      close() {
        this.closed = true;
      },
      produce: async () => {
        throw produceError;
      }
    };

    Reflect.set(session, 'activeChannelIndex', 0);
    Reflect.set(session, 'listChannels', async (): Promise<TIptvChannel[]> => {
      return [
        {
          name: 'Sports HD',
          logo: 'https://cdn.example/sports.png',
          url: 'https://8.8.8.8/live.m3u8'
        }
      ];
    });
    Reflect.set(session, 'prepareChannelSource', async () => {
      return {
        shouldTranscodeVideo: false
      };
    });
    Reflect.set(session, 'stopStreamInternal', async () => {});

    let createPlainTransportCalls = 0;
    let createExternalStreamCalls = 0;
    const originalFindById = VoiceRuntime.findById;
    VoiceRuntime.findById = ((_) => {
      return {
        getRouter: () => ({
          createPlainTransport: async () => {
            createPlainTransportCalls += 1;

            return createPlainTransportCalls === 1
              ? videoTransport
              : audioTransport;
          }
        }),
        createExternalStream: () => {
          createExternalStreamCalls += 1;
          return 0;
        }
      } as unknown as VoiceRuntime;
    }) as typeof VoiceRuntime.findById;

    try {
      await expect(startSelectedChannelInternal.call(session)).rejects.toThrow(
        produceError.message
      );
    } finally {
      VoiceRuntime.findById = originalFindById;
    }

    expect(createPlainTransportCalls).toBe(2);
    expect(createExternalStreamCalls).toBe(0);
    expect(videoProducer.closed).toBe(true);
    expect(videoTransport.closed).toBe(true);
    expect(audioTransport.closed).toBe(true);
    expect(Reflect.get(session, 'videoTransport')).toBeUndefined();
    expect(Reflect.get(session, 'audioTransport')).toBeUndefined();
    expect(Reflect.get(session, 'videoProducer')).toBeUndefined();
    expect(Reflect.get(session, 'audioProducer')).toBeUndefined();
    expect(Reflect.get(session, 'externalStreamId')).toBeUndefined();
  });

  test('clears ffmpeg state when restart shutdown times out', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const restartFfmpegInternal = getRestartFfmpegInternal(session);
    const stopError = new Error('Timed out waiting for ffmpeg to stop');

    Reflect.set(session, 'activeChannelIndex', 0);
    Reflect.set(session, 'videoTransport', {
      tuple: { localPort: 5004 },
      rtcpTuple: { localPort: 5005 }
    });
    Reflect.set(session, 'audioTransport', {
      tuple: { localPort: 5006 },
      rtcpTuple: { localPort: 5007 }
    });
    Reflect.set(session, 'videoProducer', {});
    Reflect.set(session, 'audioProducer', {});
    Reflect.set(session, 'externalStreamId', 123);
    Reflect.set(session, 'ffmpegProcess', { exitCode: null });
    Reflect.set(session, 'ffmpegStderr', 'ffmpeg stderr');
    Reflect.set(session, 'expectedStop', false);
    Reflect.set(session, 'listChannels', async (): Promise<TIptvChannel[]> => {
      return [
        {
          name: 'Sports HD',
          logo: 'https://cdn.example/sports.png',
          url: 'https://8.8.8.8/live.m3u8'
        }
      ];
    });
    Reflect.set(
      session,
      'prepareChannelSource',
      async (): Promise<{
        shouldTranscodeVideo: boolean;
        videoCodec?: string;
        videoFilter?: string;
        targetVideoCrf?: number;
        targetVideoMaxRateKbps?: number;
        targetVideoBufferSizeKbps?: number;
      }> => {
        return {
          shouldTranscodeVideo: false,
          videoCodec: 'h264'
        };
      }
    );
    Reflect.set(session, 'stopFfmpegProcess', async () => {
      throw stopError;
    });

    const updatedStreams: Array<{
      streamId: number;
      data: { title: string; avatarUrl?: string };
    }> = [];
    const originalFindById = VoiceRuntime.findById;
    VoiceRuntime.findById = ((_) => {
      return {
        updateExternalStream: (
          streamId: number,
          data: { title: string; avatarUrl?: string }
        ) => {
          updatedStreams.push({ streamId, data });
        }
      } as unknown as VoiceRuntime;
    }) as typeof VoiceRuntime.findById;

    try {
      await expect(restartFfmpegInternal.call(session)).rejects.toThrow(
        stopError.message
      );
    } finally {
      VoiceRuntime.findById = originalFindById;
    }

    expect(updatedStreams).toEqual([
      {
        streamId: 123,
        data: {
          title: 'Sports HD',
          avatarUrl: 'https://cdn.example/sports.png'
        }
      }
    ]);
    expect(Reflect.get(session, 'expectedStop')).toBe(false);
    expect(Reflect.get(session, 'ffmpegProcess')).toBeUndefined();
    expect(Reflect.get(session, 'ffmpegStderr')).toBe('');
  });
});
