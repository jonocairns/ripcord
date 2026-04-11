import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const getProducersRoute = protectedProcedure.query(async ({ ctx }) => {
  await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

  const runtime = VoiceRuntime.requireJoinedRuntime(
    ctx.currentVoiceChannelId,
    ctx.user.id
  );

  return runtime.getRemoteIds(ctx.user.id);
});

export { getProducersRoute };
