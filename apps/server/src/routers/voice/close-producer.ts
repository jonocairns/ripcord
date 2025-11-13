import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const closeProducerRoute = protectedProcedure.mutation(async ({ ctx }) => {
  await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

  invariant(ctx.currentVoiceChannelId, {
    code: 'BAD_REQUEST',
    message: 'User is not in a voice channel'
  });

  const runtime = VoiceRuntime.findById(ctx.currentVoiceChannelId);

  invariant(runtime, {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Voice runtime not found for this channel'
  });

  const producerTransport = runtime.getProducerTransport(ctx.user.id);

  invariant(producerTransport, {
    code: 'NOT_FOUND',
    message: 'Producer transport not found'
  });

  producerTransport.close();

  // TODO: broadcast to other users that this producer has been closed
  // await channel.send(
  //   SocketSubscription.PRODUCER_CLOSED,
  //   {
  //     remoteUserId: ws.state.userId,
  //     kind: data.kind
  //   },
  //   [ws.state.userId]
  // );
});

export { closeProducerRoute };
