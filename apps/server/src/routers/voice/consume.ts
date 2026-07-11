import { Permission, StreamKind } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { rtpCapabilitiesSchema } from './schemas';

const consumeRoute = protectedProcedure
	.input(
		z.object({
			kind: z.enum(StreamKind),
			remoteId: z.number(),
			rtpCapabilities: rtpCapabilitiesSchema,
			paused: z.boolean().optional().default(false),
			transportId: z.string().optional(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		const producer = runtime.getProducer(input.kind, input.remoteId);

		invariant(producer, {
			code: 'NOT_FOUND',
			message: 'Producer not found',
		});

		const userConsumerTransport = runtime.getConsumerTransport(ctx.user.id);

		invariant(userConsumerTransport, {
			code: 'NOT_FOUND',
			message: 'Consumer transport not found',
		});
		invariant(input.transportId === undefined || userConsumerTransport.id === input.transportId, {
			code: 'BAD_REQUEST',
			message: 'Consumer transport id mismatch',
		});

		const router = runtime.getRouter();
		const routerCanConsume = router.canConsume({
			producerId: producer.id,
			rtpCapabilities: input.rtpCapabilities,
		});

		invariant(routerCanConsume, {
			code: 'BAD_REQUEST',
			message: 'Cannot consume this producer with the given RTP capabilities',
		});

		const consumer = await userConsumerTransport.consume({
			producerId: producer.id,
			rtpCapabilities: input.rtpCapabilities,
			paused: input.paused,
		});
		if (runtime.getConsumerTransport(ctx.user.id) !== userConsumerTransport) {
			consumer.close();
			invariant(false, {
				code: 'BAD_REQUEST',
				message: 'Consumer transport replaced during consume',
			});
		}

		runtime.addConsumer(ctx.user.id, input.remoteId, input.kind, consumer);

		return {
			producerId: producer.id,
			consumerId: consumer.id,
			consumerKind: input.kind,
			consumerRtpParameters: consumer.rtpParameters,
			consumerType: consumer.type,
		};
	});

export { consumeRoute };
