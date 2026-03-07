import type { TIptvChannel } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { IptvSession } from '../iptv';

const getPrepareChannelSource = (session: IptvSession) => {
  return Reflect.get(session, 'prepareChannelSource') as (
    channel: TIptvChannel
  ) => Promise<{ shouldTranscodeVideo: boolean; videoCodec?: string }>;
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
});
