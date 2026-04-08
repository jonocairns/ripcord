import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const restartProducerIceRoute = protectedProcedure.mutation(async ({ ctx }) => {
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

  const transport = runtime.getProducerTransport(ctx.user.id);

  invariant(transport, {
    code: 'NOT_FOUND',
    message: 'Producer transport not found'
  });

  const iceParameters = await transport.restartIce();

  return { iceParameters };
});

export { restartProducerIceRoute };
