import {
  ChannelPermission,
  ChannelType,
  Permission,
  ServerEvents,
  type TIptvStatus
} from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, iptvSources } from '../../db/schema';
import {
  getIptvSession,
  getIptvStatus,
  removeIptvSession,
  upsertIptvSession
} from '../../runtimes/iptv';
import { invariant } from '../../utils/invariant';
import {
  assertSafeIptvUrl,
  clearIptvPlaylistCache,
  fetchAndParsePlaylist
} from '../../utils/iptv-playlist';
import { protectedProcedure, t } from '../../utils/trpc';

const channelInput = z.object({
  channelId: z.number()
});

const normalizePinnedChannelUrls = (channelUrls: string[]): string[] => {
  const normalizedUrls: string[] = [];
  const seenUrls = new Set<string>();

  for (const channelUrl of channelUrls) {
    const normalizedUrl = channelUrl.trim();

    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    normalizedUrls.push(normalizedUrl);
  }

  return normalizedUrls;
};

const configureRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      playlistUrl: z.string().url(),
      enabled: z.boolean().default(true)
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);
    await assertSafeIptvUrl(input.playlistUrl);

    const channel = await db
      .select({
        id: channels.id,
        type: channels.type
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .get();

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    invariant(channel.type === ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Channel is not a voice channel'
    });

    const now = Date.now();
    const existing = await db
      .select()
      .from(iptvSources)
      .where(eq(iptvSources.channelId, input.channelId))
      .get();

    if (existing && existing.playlistUrl !== input.playlistUrl) {
      clearIptvPlaylistCache();
    }

    const source = existing
      ? await db
          .update(iptvSources)
          .set({
            playlistUrl: input.playlistUrl,
            enabled: input.enabled,
            updatedAt: now
          })
          .where(eq(iptvSources.channelId, input.channelId))
          .returning()
          .get()
      : await db
          .insert(iptvSources)
          .values({
            channelId: input.channelId,
            playlistUrl: input.playlistUrl,
            pinnedChannelUrls: [],
            enabled: input.enabled,
            createdAt: now
          })
          .returning()
          .get();

    invariant(source, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to save IPTV source'
    });

    const session = upsertIptvSession(input.channelId, {
      playlistUrl: source.playlistUrl,
      enabled: source.enabled,
      activeChannelIndex: source.activeChannelIndex
    });

    if (!source.enabled) {
      await session.stopStream();
    }

    return source;
  });

const removeRoute = protectedProcedure
  .input(channelInput)
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    await db
      .delete(iptvSources)
      .where(eq(iptvSources.channelId, input.channelId))
      .run();

    await removeIptvSession(input.channelId);

    return { removed: true };
  });

const getConfigRoute = protectedProcedure
  .input(channelInput)
  .query(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    return (
      (await db
        .select()
        .from(iptvSources)
        .where(eq(iptvSources.channelId, input.channelId))
        .get()) ?? null
    );
  });

const getViewerConfigRoute = protectedProcedure
  .input(channelInput)
  .query(async ({ input, ctx }) => {
    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    const source = await db
      .select({
        enabled: iptvSources.enabled,
        pinnedChannelUrls: iptvSources.pinnedChannelUrls
      })
      .from(iptvSources)
      .where(eq(iptvSources.channelId, input.channelId))
      .get();

    if (!source) {
      return {
        configured: false,
        enabled: false,
        pinnedChannelUrls: []
      };
    }

    return {
      configured: true,
      enabled: source.enabled,
      pinnedChannelUrls: source.pinnedChannelUrls
    };
  });

const listChannelsRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      playlistUrl: z.string().url().optional()
    })
  )
  .query(async ({ input, ctx }) => {
    if (input.playlistUrl) {
      await ctx.needsPermission(Permission.MANAGE_CHANNELS);
      await assertSafeIptvUrl(input.playlistUrl);
      return await fetchAndParsePlaylist(input.playlistUrl);
    }

    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    const source = await db
      .select()
      .from(iptvSources)
      .where(eq(iptvSources.channelId, input.channelId))
      .get();

    invariant(source, {
      code: 'NOT_FOUND',
      message: 'IPTV is not configured for this channel'
    });

    invariant(source.enabled, {
      code: 'BAD_REQUEST',
      message: 'IPTV is disabled for this channel'
    });

    return await fetchAndParsePlaylist(source.playlistUrl);
  });

const playRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      channelIndex: z.number().int().min(0)
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.MANAGE_IPTV
    );

    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    const source = await db
      .select()
      .from(iptvSources)
      .where(eq(iptvSources.channelId, input.channelId))
      .get();

    invariant(source, {
      code: 'NOT_FOUND',
      message: 'IPTV is not configured for this channel'
    });

    invariant(source.enabled, {
      code: 'BAD_REQUEST',
      message: 'IPTV is disabled for this channel'
    });

    const session = upsertIptvSession(input.channelId, {
      playlistUrl: source.playlistUrl,
      enabled: source.enabled,
      activeChannelIndex: source.activeChannelIndex
    });

    await session.switchChannel(input.channelIndex);

    await db
      .update(iptvSources)
      .set({
        activeChannelIndex: input.channelIndex,
        updatedAt: Date.now()
      })
      .where(eq(iptvSources.channelId, input.channelId))
      .run();

    return session.getStatus();
  });

const stopRoute = protectedProcedure
  .input(channelInput)
  .mutation(async ({ input, ctx }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.MANAGE_IPTV
    );

    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    const session = getIptvSession(input.channelId);

    if (!session) {
      await db
        .update(iptvSources)
        .set({
          activeChannelIndex: null,
          updatedAt: Date.now()
        })
        .where(eq(iptvSources.channelId, input.channelId))
        .run();

      const idleStatus: TIptvStatus = { status: 'idle' };
      return idleStatus;
    }

    await session.stopStream({
      clearActiveChannel: true
    });

    await db
      .update(iptvSources)
      .set({
        activeChannelIndex: null,
        updatedAt: Date.now()
      })
      .where(eq(iptvSources.channelId, input.channelId))
      .run();

    return session.getStatus();
  });

const setPinnedChannelRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      channelUrl: z.string().url(),
      pinned: z.boolean()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.MANAGE_IPTV
    );

    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    await assertSafeIptvUrl(input.channelUrl);

    const source = await db
      .select({
        pinnedChannelUrls: iptvSources.pinnedChannelUrls
      })
      .from(iptvSources)
      .where(eq(iptvSources.channelId, input.channelId))
      .get();

    invariant(source, {
      code: 'NOT_FOUND',
      message: 'IPTV is not configured for this channel'
    });

    const nextPinnedChannelUrls = normalizePinnedChannelUrls(
      input.pinned
        ? [...source.pinnedChannelUrls, input.channelUrl]
        : source.pinnedChannelUrls.filter(
            (channelUrl) => channelUrl !== input.channelUrl
          )
    );

    const updatedSource = await db
      .update(iptvSources)
      .set({
        pinnedChannelUrls: nextPinnedChannelUrls,
        updatedAt: Date.now()
      })
      .where(eq(iptvSources.channelId, input.channelId))
      .returning({
        pinnedChannelUrls: iptvSources.pinnedChannelUrls
      })
      .get();

    invariant(updatedSource, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update pinned IPTV channels'
    });

    return updatedSource;
  });

const getStatusRoute = protectedProcedure
  .input(channelInput)
  .query(async ({ input, ctx }) => {
    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    return getIptvStatus(input.channelId);
  });

const onStatusChangeRoute = protectedProcedure
  .input(channelInput)
  .subscription(async ({ input, ctx }) => {
    invariant(ctx.currentVoiceChannelId === input.channelId, {
      code: 'FORBIDDEN',
      message: 'You must be in this voice channel'
    });

    return ctx.pubsub.subscribeForChannel(
      input.channelId,
      ServerEvents.IPTV_STATUS_CHANGE
    );
  });

export const iptvRouter = t.router({
  configure: configureRoute,
  remove: removeRoute,
  getConfig: getConfigRoute,
  getViewerConfig: getViewerConfigRoute,
  listChannels: listChannelsRoute,
  play: playRoute,
  stop: stopRoute,
  setPinnedChannel: setPinnedChannelRoute,
  getStatus: getStatusRoute,
  onStatusChange: onStatusChangeRoute
});
