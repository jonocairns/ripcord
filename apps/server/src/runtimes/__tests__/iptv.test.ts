import type { TIptvChannel } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { IptvSession } from '../iptv';
import { VoiceRuntime } from '../voice';

const getPrepareChannelSource = (session: IptvSession) => {
  return Reflect.get(session, 'prepareChannelSource') as (
    channel: TIptvChannel
  ) => Promise<{ shouldTranscodeVideo: boolean; videoCodec?: string }>;
};

const getStopStreamInternal = (session: IptvSession) => {
  return Reflect.get(session, 'stopStreamInternal') as (options?: {
    publishIdle?: boolean;
    clearActiveChannel?: boolean;
  }) => Promise<void>;
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
      videoCodec: undefined
    });
  });

  test('keeps video copy mode when ffprobe identifies an h264 source', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = getPrepareChannelSource(session);

    Reflect.set(
      session,
      'inspectSourceStreams',
      async (): Promise<{
        summary: { hasVideo: boolean; hasAudio: boolean; videoCodec: string };
      }> => {
        return {
          summary: {
            hasVideo: true,
            hasAudio: true,
            videoCodec: 'h264'
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
      videoCodec: 'h264'
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
});
