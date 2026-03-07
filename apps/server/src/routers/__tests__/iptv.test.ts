import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { iptvSources } from '../../db/schema';
import { appRouter } from '../../routers';
import {
  getIptvSession,
  removeIptvSession,
  upsertIptvSession
} from '../../runtimes/iptv';

const VOICE_CHANNEL_ID = 2;
const createCaller = async (options?: {
  userId?: number;
  currentVoiceChannelId?: number;
}) => {
  const token = await getMockedToken(options?.userId ?? 1);
  const ctx = await createMockContext({
    customToken: token
  });

  ctx.authenticated = true;
  ctx.currentVoiceChannelId = options?.currentVoiceChannelId;

  return appRouter.createCaller(ctx);
};

describe('iptv router', () => {
  test('configure persists the always-transcode setting', async () => {
    const caller = await createCaller();

    const source = await caller.iptv.configure({
      channelId: VOICE_CHANNEL_ID,
      playlistUrl: 'https://8.8.8.8/playlist.m3u8',
      enabled: true,
      alwaysTranscodeVideo: true
    });

    const persistedSource = await tdb
      .select()
      .from(iptvSources)
      .where(eq(iptvSources.channelId, VOICE_CHANNEL_ID))
      .get();

    expect(source.alwaysTranscodeVideo).toBe(true);
    expect(persistedSource?.alwaysTranscodeVideo).toBe(true);
  });

  test('manual stop clears the selected channel for a live session', async () => {
    const caller = await createCaller({
      currentVoiceChannelId: VOICE_CHANNEL_ID
    });
    const now = Date.now();

    await tdb.insert(iptvSources).values({
      channelId: VOICE_CHANNEL_ID,
      playlistUrl: 'https://8.8.8.8/playlist.m3u8',
      pinnedChannelUrls: [],
      activeChannelIndex: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now
    });

    const session = upsertIptvSession(VOICE_CHANNEL_ID, {
      playlistUrl: 'https://8.8.8.8/playlist.m3u8',
      enabled: true,
      activeChannelIndex: 0
    });

    try {
      const status = await caller.iptv.stop({
        channelId: VOICE_CHANNEL_ID
      });

      const source = await tdb
        .select()
        .from(iptvSources)
        .where(eq(iptvSources.channelId, VOICE_CHANNEL_ID))
        .get();

      expect(status).toEqual({ status: 'idle' });
      expect(session.getStatus()).toEqual({ status: 'idle' });
      expect(source?.activeChannelIndex).toBeNull();
      expect(getIptvSession(VOICE_CHANNEL_ID)).toBe(session);
    } finally {
      await removeIptvSession(VOICE_CHANNEL_ID);
    }
  });

  test('manual stop clears persisted selection even without a live session', async () => {
    const caller = await createCaller({
      currentVoiceChannelId: VOICE_CHANNEL_ID
    });
    const now = Date.now();

    await tdb.insert(iptvSources).values({
      channelId: VOICE_CHANNEL_ID,
      playlistUrl: 'https://8.8.8.8/playlist.m3u8',
      pinnedChannelUrls: [],
      activeChannelIndex: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now
    });

    try {
      const status = await caller.iptv.stop({
        channelId: VOICE_CHANNEL_ID
      });

      const source = await tdb
        .select()
        .from(iptvSources)
        .where(eq(iptvSources.channelId, VOICE_CHANNEL_ID))
        .get();

      expect(status).toEqual({ status: 'idle' });
      expect(source?.activeChannelIndex).toBeNull();
      expect(getIptvSession(VOICE_CHANNEL_ID)).toBeUndefined();
    } finally {
      await removeIptvSession(VOICE_CHANNEL_ID);
    }
  });

  test('getConfig requires manage channels permission', async () => {
    const caller = await createCaller({
      userId: 2
    });

    await expect(
      caller.iptv.getConfig({
        channelId: VOICE_CHANNEL_ID
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('getViewerConfig returns a redacted config for in-channel viewers', async () => {
    const caller = await createCaller({
      userId: 2,
      currentVoiceChannelId: VOICE_CHANNEL_ID
    });
    const now = Date.now();

    await tdb.insert(iptvSources).values({
      channelId: VOICE_CHANNEL_ID,
      playlistUrl: 'https://example.com/playlist.m3u8?token=secret',
      pinnedChannelUrls: ['https://example.com/channel-1.m3u8'],
      activeChannelIndex: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now
    });

    const config = await caller.iptv.getViewerConfig({
      channelId: VOICE_CHANNEL_ID
    });

    expect(config).toEqual({
      configured: true,
      enabled: true,
      pinnedChannelUrls: ['https://example.com/channel-1.m3u8']
    });
    expect('playlistUrl' in config).toBe(false);
  });

  test('getViewerConfig requires the caller to be in the voice channel', async () => {
    const caller = await createCaller({
      userId: 2
    });

    await expect(
      caller.iptv.getViewerConfig({
        channelId: VOICE_CHANNEL_ID
      })
    ).rejects.toThrow('You must be in this voice channel');
  });

  test('getStatus requires the caller to be in the voice channel', async () => {
    const caller = await createCaller({
      userId: 2
    });

    await expect(
      caller.iptv.getStatus({
        channelId: VOICE_CHANNEL_ID
      })
    ).rejects.toThrow('You must be in this voice channel');
  });
});
