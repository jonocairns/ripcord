import { Permission } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { dtlsParametersSchema } from './schemas';

const connectConsumerTransportRoute = protectedProcedure
	.input(
		z.object({
			dtlsParameters: dtlsParametersSchema,
			transportId: z.string().optional(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		const consumerTransport = runtime.getConsumerTransport(ctx.user.id);

		invariant(consumerTransport, {
			code: 'NOT_FOUND',
			message: 'Consumer transport not found',
		});
		invariant(input.transportId === undefined || consumerTransport.id === input.transportId, {
			code: 'BAD_REQUEST',
			message: 'Consumer transport id mismatch',
		});

		await consumerTransport.connect({ dtlsParameters: input.dtlsParameters });
	});

export { connectConsumerTransportRoute };
