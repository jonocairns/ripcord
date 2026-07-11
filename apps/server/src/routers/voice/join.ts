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

		const sessionIncarnation = runtime.getVoiceSessionIncarnation(ctx.user.id);
		const state = runtime.getUserState(ctx.user.id);

		ctx.currentVoiceChannelId = channel.id;
		ctx.currentVoiceSessionIncarnation = sessionIncarnation;
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
				// Only clear this connection's bookkeeping if it still describes the
				// session this join created — a newer join on the same connection may
				// have already replaced it.
				if (ctx.currentVoiceSessionIncarnation === sessionIncarnation) {
					ctx.currentVoiceChannelId = undefined;
					ctx.currentVoiceSessionIncarnation = undefined;
					ctx.setWsVoiceChannelId(undefined);
				}

				// A concurrent join or restore may have replaced the seat while the
				// transports were being built. Rolling back by user id would remove
				// the successor's live session; the successor already published the
				// eviction of this one.
				if (runtime.getVoiceSessionIncarnation(ctx.user.id) !== sessionIncarnation) {
					logger.warn(
						'Skipped voice join rollback for %s in channel %s: seat superseded by a newer session',
						ctx.user.name,
						channel.name,
					);
					return;
				}

				runtime.removeUser(ctx.user.id);
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
