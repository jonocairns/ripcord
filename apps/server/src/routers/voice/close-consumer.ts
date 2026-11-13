import { CLOSE_CONSUMER_INTENTS, Permission, StreamKind } from '@sharkord/shared';
import z from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const closeConsumerRoute = protectedProcedure
	.input(
		z.object({
			remoteId: z.number(),
			kind: z.enum(StreamKind),
			consumerId: z.string().optional(),
			// Optional for already-shipped clients, which send no intent. They
			// only distinguish nothing, so their closes keep counting as stops.
			intent: z.enum(CLOSE_CONSUMER_INTENTS).optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		runtime.removeConsumer(ctx.user.id, input.remoteId, input.kind, input.consumerId, {
			stopWatching: input.intent !== 'maintenance',
		});
	});

export { closeConsumerRoute };
