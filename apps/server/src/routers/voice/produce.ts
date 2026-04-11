import {
  ChannelPermission,
  getMediasoupKind,
  Permission,
  ServerEvents,
  StreamKind
} from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const produceRoute = protectedProcedure
  .input(
    z.object({
      transportId: z.string(),
      kind: z.enum(StreamKind),
      rtpParameters: z.any()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
    const runtime = VoiceRuntime.requireJoinedRuntime(
      ctx.currentVoiceChannelId,
      ctx.user.id
    );
    const channelId = runtime.id;

    if (input.kind === StreamKind.AUDIO) {
      await ctx.needsChannelPermission(channelId, ChannelPermission.SPEAK);
    } else if (input.kind === StreamKind.VIDEO) {
      await ctx.needsChannelPermission(channelId, ChannelPermission.WEBCAM);
    } else if (input.kind === StreamKind.SCREEN) {
      await ctx.needsChannelPermission(
        channelId,
        ChannelPermission.SHARE_SCREEN
      );
    }

    const producerTransport = runtime.getProducerTransport(ctx.user.id);

    invariant(producerTransport, {
      code: 'NOT_FOUND',
      message: 'Producer transport not found'
    });

    const producer = await producerTransport.produce({
      kind: getMediasoupKind(input.kind),
      rtpParameters: input.rtpParameters,
      appData: { kind: input.kind, userId: ctx.user.id }
    });

    runtime.addProducer(ctx.user.id, input.kind, producer);

    ctx.pubsub.publishForChannel(channelId, ServerEvents.VOICE_NEW_PRODUCER, {
      channelId,
      remoteId: ctx.user.id,
      kind: input.kind
    });

    return producer.id;
  });

export { produceRoute };
