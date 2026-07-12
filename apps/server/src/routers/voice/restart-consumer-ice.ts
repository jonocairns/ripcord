import { Permission } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const restartConsumerIceRoute = protectedProcedure
	.input(z.object({ transportId: z.string().optional() }).optional())
	.mutation(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		const transport = runtime.getConsumerTransport(ctx.user.id);

		invariant(transport, {
			code: 'NOT_FOUND',
			message: 'Consumer transport not found',
		});
		invariant(input?.transportId === undefined || transport.id === input.transportId, {
			code: 'BAD_REQUEST',
			message: 'Consumer transport id mismatch',
		});

		const iceParameters = await transport.restartIce();

		return { iceParameters };
	});

export { restartConsumerIceRoute };
