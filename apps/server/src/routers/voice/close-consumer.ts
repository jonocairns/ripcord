import { Permission, StreamKind } from '@sharkord/shared';
import z from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const closeConsumerRoute = protectedProcedure
  .input(
    z.object({
      remoteId: z.number(),
      kind: z.enum(StreamKind)
    })
  )
  .mutation(async ({ ctx, input }) => {
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

    runtime.removeConsumer(ctx.user.id, input.remoteId, input.kind);
  });

export { closeConsumerRoute };
