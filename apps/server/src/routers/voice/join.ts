import { ServerEvents } from '@sharkord/shared';
import { config } from '../../config';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';
import { createVoiceJoinBootstrap, getVoiceJoinTarget, voiceJoinInputSchema } from './bootstrap';

const joinVoiceRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: config.rateLimiters.joinVoiceChannel.maxRequests,
	windowMs: config.rateLimiters.joinVoiceChannel.windowMs,
	logLabel: 'joinVoice',
})
	.input(voiceJoinInputSchema)
	.mutation(async ({ input, ctx }) => {
		const { channel, runtime } = await getVoiceJoinTarget(ctx, input.channelId);

		const userAlreadyInVoiceChannel = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
		const isReconnecting = userAlreadyInVoiceChannel?.id === input.channelId;

		if (userAlreadyInVoiceChannel) {
			userAlreadyInVoiceChannel.removeUser(ctx.user.id);
			ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
				channelId: userAlreadyInVoiceChannel.id,
				userId: ctx.user.id,
				reconnecting: isReconnecting,
			});
			ctx.pubsub.publishFor(ctx.user.id, ServerEvents.VOICE_SESSION_REPLACED, {
				channelId: userAlreadyInVoiceChannel.id,
			});

			logger.info(
				'%s evicted from voice channel %s (session replaced by new join)',
				ctx.user.name,
				userAlreadyInVoiceChannel.id,
			);
		}

		runtime.addUser(ctx.user.id, input.state);

		const state = runtime.getUserState(ctx.user.id);

		ctx.currentVoiceChannelId = channel.id;
		ctx.setWsVoiceChannelId(channel.id);
		ctx.pubsub.publish(ServerEvents.USER_JOIN_VOICE, {
			channelId: input.channelId,
			userId: ctx.user.id,
			state,
			reconnecting: isReconnecting,
		});

		logger.info('%s joined voice channel %s', ctx.user.name, channel.name);

		return createVoiceJoinBootstrap({
			runtime,
			userId: ctx.user.id,
			onError: (error) => {
				runtime.removeUser(ctx.user.id);
				ctx.currentVoiceChannelId = undefined;
				ctx.setWsVoiceChannelId(undefined);
				ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
					channelId: input.channelId,
					userId: ctx.user.id,
					reconnecting: isReconnecting,
				});

				logger.error(
					'Failed to create transports for %s in voice channel %s, rolled back join',
					ctx.user.name,
					channel.name,
					error,
				);
			},
		});
	});

export { joinVoiceRoute };
