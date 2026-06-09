import { Permission, StreamKind } from '@sharkord/shared';
import z from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const resumeConsumerRoute = protectedProcedure
	.input(
		z.object({
			remoteId: z.number(),
			kind: z.enum(StreamKind),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		await runtime.resumeConsumer(ctx.user.id, input.remoteId, input.kind);
	});

export { resumeConsumerRoute };
