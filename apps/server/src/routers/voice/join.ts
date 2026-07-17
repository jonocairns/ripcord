import { ServerEvents } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { config } from '../../config';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { type Context, protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';
import { clearVoiceRestoreBlockAfterKick } from '../../utils/voice-kick-guard';
import { getVoiceJoinTarget, prepareVoiceJoinBootstrap, voiceJoinInputSchema } from './bootstrap';
import { createVoiceJoinService, type TVoiceJoinPresenceEvent, VoiceJoinSupersededError } from './join-service';
import {
	VoiceSessionAttemptCancelledError,
	VoiceSessionAttemptSupersededError,
	voiceSessionAttemptRegistry,
} from './session-attempt-registry';
import { voiceSessionTelemetry } from './voice-session-telemetry';

const joinVoiceService = createVoiceJoinService({
	findRuntimeByChannelId: VoiceRuntime.findById,
	findRuntimeByUserId: VoiceRuntime.findRuntimeByUserId,
	prepareBootstrap: prepareVoiceJoinBootstrap,
	attemptRegistry: voiceSessionAttemptRegistry,
	observer: voiceSessionTelemetry,
	logJoined: (userName, channelName) => {
		logger.info('%s joined voice channel %s', userName, channelName);
	},
	logReplaced: (userName, channelId) => {
		logger.info('%s evicted from voice channel %s (session replaced by new join)', userName, channelId);
	},
});

const joinVoiceRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: config.rateLimiters.joinVoiceChannel.maxRequests,
	windowMs: config.rateLimiters.joinVoiceChannel.windowMs,
	logLabel: 'joinVoice',
})
	.input(voiceJoinInputSchema)
	.mutation(async ({ input, ctx, signal }) => {
		try {
			const result = await joinVoiceService.join({
				channelId: input.channelId,
				state: input.state,
				mutationSeq: input.mutationSeq,
				user: ctx.user,
				signal,
				context: createVoiceJoinRequestContext(ctx),
			});

			clearVoiceRestoreBlockAfterKick(ctx.user.id, {
				clientInstanceId: ctx.getClientInstanceId(),
				token: ctx.token,
			});
			return result;
		} catch (error) {
			if (
				error instanceof VoiceJoinSupersededError ||
				error instanceof VoiceSessionAttemptCancelledError ||
				error instanceof VoiceSessionAttemptSupersededError
			) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'Voice join superseded by a newer voice mutation',
				});
			}

			throw error;
		}
	});

const createVoiceJoinRequestContext = (ctx: Context) => ({
	resolveTarget: (channelId: number) => getVoiceJoinTarget(ctx, channelId),
	getClientInstanceId: ctx.getClientInstanceId,
	getConnectionIdentity: () => ctx.getOwnWs(),
	registerMutation: ctx.registerVoiceSessionMutation,
	isMutationCurrent: ctx.isCurrentVoiceSessionMutation,
	getBinding: () => ({
		channelId: ctx.currentVoiceChannelId,
		sessionIncarnation: ctx.currentVoiceSessionIncarnation,
	}),
	bindVoiceSession: (channelId: number, sessionIncarnation: symbol) => {
		ctx.currentVoiceChannelId = channelId;
		ctx.currentVoiceSessionIncarnation = sessionIncarnation;
		ctx.setWsVoiceChannelId(channelId);
	},
	clearBindingIfMatches: (binding: { channelId?: number; sessionIncarnation?: symbol }) => {
		if (
			ctx.currentVoiceChannelId !== binding.channelId ||
			ctx.currentVoiceSessionIncarnation !== binding.sessionIncarnation
		) {
			return;
		}

		ctx.currentVoiceChannelId = undefined;
		ctx.currentVoiceSessionIncarnation = undefined;
		ctx.setWsVoiceChannelId(undefined);
	},
	publishPresence: (event: TVoiceJoinPresenceEvent) => publishVoiceJoinPresence(ctx, event),
});

const publishVoiceJoinPresence = (ctx: Context, event: TVoiceJoinPresenceEvent) => {
	switch (event.type) {
		case 'leave':
			ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
				channelId: event.channelId,
				userId: event.userId,
				reconnecting: event.reconnecting,
			});
			return;
		case 'session-replaced':
			ctx.pubsub.publishFor(event.userId, ServerEvents.VOICE_SESSION_REPLACED, {
				channelId: event.channelId,
				replacedByClientInstanceId: event.replacedByClientInstanceId,
			});
			return;
		case 'join':
			ctx.pubsub.publish(ServerEvents.USER_JOIN_VOICE, {
				channelId: event.channelId,
				userId: event.userId,
				state: event.state,
				reconnecting: event.reconnecting,
			});
	}
};

export { joinVoiceRoute };
