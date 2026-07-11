import { Permission, StreamKind } from '@sharkord/shared';
import z from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const resumeConsumerRoute = protectedProcedure
	.input(
		z.object({
			remoteId: z.number(),
			kind: z.enum(StreamKind),
			consumerId: z.string().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		const resumed = await runtime.resumeConsumer(ctx.user.id, input.remoteId, input.kind, input.consumerId);
		invariant(input.consumerId === undefined || resumed, {
			code: 'BAD_REQUEST',
			message: 'Consumer id mismatch',
		});
	});

export { resumeConsumerRoute };
