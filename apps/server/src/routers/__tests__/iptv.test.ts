import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

describe('iptv router', () => {
  test('should keep legacy IPTV procedures as inert compatibility handlers', async () => {
    const { caller } = await initTest();

    await expect(
      caller.iptv.configure({
        channelId: 1,
        playlistUrl: 'https://example.com/playlist.m3u8',
        enabled: true,
        alwaysTranscodeVideo: false
      })
    ).resolves.toBeNull();

    await expect(
      caller.iptv.remove({
        channelId: 1
      })
    ).resolves.toEqual({ removed: true });

    await expect(
      caller.iptv.getConfig({
        channelId: 1
      })
    ).resolves.toBeNull();

    await expect(
      caller.iptv.getViewerConfig({
        channelId: 1
      })
    ).resolves.toEqual({
      configured: false,
      enabled: false,
      pinnedChannelUrls: []
    });

    await expect(
      caller.iptv.listChannels({
        channelId: 1
      })
    ).resolves.toEqual([]);

    await expect(
      caller.iptv.listChannels({
        channelId: 1,
        playlistUrl: 'https://example.com/playlist.m3u8'
      })
    ).resolves.toEqual([]);

    await expect(
      caller.iptv.play({
        channelId: 1,
        channelIndex: 0
      })
    ).resolves.toEqual({ status: 'idle' });

    await expect(
      caller.iptv.stop({
        channelId: 1
      })
    ).resolves.toEqual({ status: 'idle' });

    await expect(
      caller.iptv.setPinnedChannel({
        channelId: 1,
        channelUrl: 'https://example.com/channel.m3u8',
        pinned: true
      })
    ).resolves.toEqual({
      pinnedChannelUrls: []
    });

    await expect(
      caller.iptv.getStatus({
        channelId: 1
      })
    ).resolves.toEqual({ status: 'idle' });
  });

  test('should expose a cancellable compatibility status subscription', async () => {
    const { caller } = await initTest();
    const timeoutSentinel = { timedOut: true };

    const result = await Promise.race([
      caller.iptv.onStatusChange({
        channelId: 1
      }),
      new Promise<typeof timeoutSentinel>((resolve) => {
        setTimeout(() => resolve(timeoutSentinel), 50);
      })
    ]);

    expect(result).not.toBe(timeoutSentinel);
  });
});
