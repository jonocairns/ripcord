// TODO: remove stub IPTV router once all clients have updated past this version
import { z } from 'zod';
import { protectedProcedure, t } from '../../utils/trpc';

const channelInput = z.object({
  channelId: z.number()
});

const viewerConfigStub: {
  configured: boolean;
  enabled: boolean;
  pinnedChannelUrls: string[];
} = {
  configured: false,
  enabled: false,
  pinnedChannelUrls: []
};

const idleStatus: { status: 'idle' } = {
  status: 'idle'
};

const iptvRouter = t.router({
  getViewerConfig: protectedProcedure
    .input(channelInput)
    .query(() => viewerConfigStub),
  getStatus: protectedProcedure.input(channelInput).query(() => idleStatus),
  onStatusChange: protectedProcedure
    .input(channelInput)
    .subscription(async function* () {
      await new Promise(() => {});
    })
});

export { iptvRouter };
