import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { protectedProcedure, t } from '../../utils/trpc';

const channelInput = z.object({
  channelId: z.number()
});

type TIptvChannel = {
  name: string;
  url: string;
  logo?: string;
  group?: string;
};

type TIptvStatus = {
  status: 'idle' | 'starting' | 'streaming' | 'error';
  activeChannel?: {
    index: number;
    name: string;
    logo?: string;
  };
  error?: string;
};

const viewerConfigStub: {
  configured: boolean;
  enabled: boolean;
  pinnedChannelUrls: string[];
} = {
  configured: false,
  enabled: false,
  pinnedChannelUrls: []
};

const idleStatus: TIptvStatus = {
  status: 'idle'
};

const emptyChannelList: TIptvChannel[] = [];

const pinnedChannelStub: {
  pinnedChannelUrls: string[];
} = {
  pinnedChannelUrls: []
};

// Keep the legacy IPTV procedure surface as inert compatibility handlers so
// older desktop clients degrade to safe no-op responses instead of throwing
// procedure-not-found errors against newer servers.
const iptvRouter = t.router({
  configure: protectedProcedure
    .input(
      z.object({
        channelId: z.number(),
        playlistUrl: z.string().url(),
        enabled: z.boolean().default(true),
        alwaysTranscodeVideo: z.boolean().default(false)
      })
    )
    .mutation(() => null),
  remove: protectedProcedure
    .input(channelInput)
    .mutation(() => ({ removed: true })),
  getConfig: protectedProcedure.input(channelInput).query(() => null),
  getViewerConfig: protectedProcedure
    .input(channelInput)
    .query(() => viewerConfigStub),
  listChannels: protectedProcedure
    .input(
      z.object({
        channelId: z.number(),
        playlistUrl: z.string().url().optional()
      })
    )
    .query(() => emptyChannelList),
  play: protectedProcedure
    .input(
      z.object({
        channelId: z.number(),
        channelIndex: z.number().int().min(0)
      })
    )
    .mutation(() => idleStatus),
  stop: protectedProcedure.input(channelInput).mutation(() => idleStatus),
  setPinnedChannel: protectedProcedure
    .input(
      z.object({
        channelId: z.number(),
        channelUrl: z.string().url(),
        pinned: z.boolean()
      })
    )
    .mutation(() => pinnedChannelStub),
  getStatus: protectedProcedure.input(channelInput).query(() => idleStatus),
  onStatusChange: protectedProcedure.input(channelInput).subscription(() => {
    return observable<TIptvStatus>(() => () => {});
  })
});

export { iptvRouter };
