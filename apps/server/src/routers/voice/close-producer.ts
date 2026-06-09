import { Permission, StreamKind } from '@sharkord/shared';
import z from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const closeProducerRoute = protectedProcedure
	.input(
		z.object({
			kind: z.enum(StreamKind),
			producerId: z.string().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

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
