import { Permission, StreamKind } from '@sharkord/shared';
import z from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const closeProducerRoute = protectedProcedure
  .input(
    z.object({
      kind: z.enum(StreamKind),
      producerId: z.string().optional()
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

    const producer = runtime.getProducer(input.kind, ctx.user.id);

    if (!producer) {
      return;
    }

    if (input.producerId && producer.id !== input.producerId) {
      return;
    }

    runtime.removeProducer(ctx.user.id, input.kind);
  });

export { closeProducerRoute };
