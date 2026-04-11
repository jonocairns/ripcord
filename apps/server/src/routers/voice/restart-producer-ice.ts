import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const restartProducerIceRoute = protectedProcedure.mutation(async ({ ctx }) => {
  await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

  const runtime = VoiceRuntime.requireJoinedRuntime(
    ctx.currentVoiceChannelId,
    ctx.user.id
  );

  const transport = runtime.getProducerTransport(ctx.user.id);

  invariant(transport, {
    code: 'NOT_FOUND',
    message: 'Producer transport not found'
  });

  const iceParameters = await transport.restartIce();

  return { iceParameters };
});

export { restartProducerIceRoute };
