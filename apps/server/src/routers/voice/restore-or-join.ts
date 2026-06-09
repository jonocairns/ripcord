import { ServerEvents } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { config } from '../../config';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';
import { getPendingVoiceReconnectChannelIdsOwnedElsewhere } from '../../utils/voice-disconnect-grace';
import { createVoiceJoinBootstrap, getVoiceJoinTarget, voiceJoinInputSchema } from './bootstrap';
import { consumeVoiceReconnectLabNextRestoreBehavior } from './reconnect-lab-state';

const VOICE_SESSION_WRONG_CHANNEL = 'VOICE_SESSION_WRONG_CHANNEL';
const VOICE_SESSION_OWNED_ELSEWHERE = 'VOICE_SESSION_OWNED_ELSEWHERE';

const restoreOrJoinVoiceRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: config.rateLimiters.joinVoiceChannel.maxRequests,
	windowMs: config.rateLimiters.joinVoiceChannel.windowMs,
	logLabel: 'restoreOrJoinVoice',
})
	.input(
		voiceJoinInputSchema.extend({
			reconnectAttemptId: z.string().min(1),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		const { channel, runtime } = await getVoiceJoinTarget(ctx, input.channelId);
		const runtimeWithUser = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
		const ownWs = ctx.getOwnWs();
		const clientInstanceId = getTrackedWsString(ownWs, 'clientInstanceId');
		const otherActiveVoiceChannelIds = ctx.getUserWss(ctx.user.id).flatMap((ws) => {
			if (isSameVoiceClientSession(ws, ownWs, clientInstanceId)) {
				return [];
			}

			const currentVoiceChannelId = getTrackedWsNumber(ws, 'currentVoiceChannelId');

			return currentVoiceChannelId === undefined ? [] : [currentVoiceChannelId];
		});
		const otherPendingVoiceChannelIds = getPendingVoiceReconnectChannelIdsOwnedElsewhere(ctx.user.id, clientInstanceId);
		const activeChannelId = runtimeWithUser?.id ?? otherActiveVoiceChannelIds[0] ?? otherPendingVoiceChannelIds[0];
		const hasOtherSessionInRequestedChannel =
			otherActiveVoiceChannelIds.includes(input.channelId) || otherPendingVoiceChannelIds.includes(input.channelId);

		logRestoreOrJoinEvent('attempt', {
			reconnectAttemptId: input.reconnectAttemptId,
			userId: ctx.user.id,
			clientInstanceId,
			requestedChannelId: input.channelId,
			activeChannelId,
		});

		if (hasOtherSessionInRequestedChannel) {
			logRestoreOrJoinEvent('conflict', {
				reconnectAttemptId: input.reconnectAttemptId,
				userId: ctx.user.id,
				clientInstanceId,
				requestedChannelId: input.channelId,
				activeChannelId: input.channelId,
				reason: VOICE_SESSION_OWNED_ELSEWHERE,
			});

			throw new TRPCError({
				code: 'CONFLICT',
				message: VOICE_SESSION_OWNED_ELSEWHERE,
			});
		}

		if (activeChannelId !== undefined && activeChannelId !== input.channelId) {
			logRestoreOrJoinEvent('conflict', {
				reconnectAttemptId: input.reconnectAttemptId,
				userId: ctx.user.id,
				clientInstanceId,
				requestedChannelId: input.channelId,
				activeChannelId,
				reason: VOICE_SESSION_WRONG_CHANNEL,
			});

			throw new TRPCError({
				code: 'CONFLICT',
				message: VOICE_SESSION_WRONG_CHANNEL,
			});
		}

		const reconnectLabBehavior = consumeVoiceReconnectLabNextRestoreBehavior(ctx.user.id);

		if (reconnectLabBehavior?.delayMs) {
			await wait(reconnectLabBehavior.delayMs);
		}

		if (reconnectLabBehavior?.closeWsCode) {
			ctx
				.getOwnWs()
				?.close(reconnectLabBehavior.closeWsCode, reconnectLabBehavior.closeWsReason ?? 'voice reconnect lab');

			throw new TRPCError({
				code: 'INTERNAL_SERVER_ERROR',
				message: 'VOICE_RECONNECT_LAB_SOCKET_CLOSED',
			});
		}

		if (reconnectLabBehavior?.failCode || reconnectLabBehavior?.failMessage) {
			throw new TRPCError({
				code: reconnectLabBehavior.failCode ?? 'INTERNAL_SERVER_ERROR',
				message: reconnectLabBehavior.failMessage ?? getReconnectLabFailureMessage(reconnectLabBehavior.failCode),
			});
		}

		if (runtimeWithUser?.id === input.channelId) {
			ctx.currentVoiceChannelId = input.channelId;
			ctx.setWsVoiceChannelId(input.channelId);

			const bootstrap = await createVoiceJoinBootstrap({
				runtime,
				userId: ctx.user.id,
			});

			logRestoreOrJoinEvent('outcome', {
				reconnectAttemptId: input.reconnectAttemptId,
				userId: ctx.user.id,
				clientInstanceId,
				requestedChannelId: input.channelId,
				activeChannelId: input.channelId,
				outcome: 'restored',
			});

			return bootstrap;
		}

		runtime.addUser(ctx.user.id, input.state);

		const state = runtime.getUserState(ctx.user.id);

		ctx.currentVoiceChannelId = channel.id;
		ctx.setWsVoiceChannelId(channel.id);
		ctx.pubsub.publish(ServerEvents.USER_JOIN_VOICE, {
			channelId: input.channelId,
			userId: ctx.user.id,
			state,
			reconnecting: true,
		});

		logger.info('%s restoreOrJoin joined voice channel %s', ctx.user.name, channel.name);

		const bootstrap = await createVoiceJoinBootstrap({
			runtime,
			userId: ctx.user.id,
			onError: (error) => {
				runtime.removeUser(ctx.user.id);
				ctx.currentVoiceChannelId = undefined;
				ctx.setWsVoiceChannelId(undefined);
				ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
					channelId: input.channelId,
					userId: ctx.user.id,
					reconnecting: true,
				});

				logger.error(
					'Failed to create transports for %s in voice channel %s, rolled back restoreOrJoin',
					ctx.user.name,
					channel.name,
					error,
				);
			},
		});

		logRestoreOrJoinEvent('outcome', {
			reconnectAttemptId: input.reconnectAttemptId,
			userId: ctx.user.id,
			clientInstanceId,
			requestedChannelId: input.channelId,
			activeChannelId: input.channelId,
			outcome: 'joined',
		});

		return bootstrap;
	});

const getTrackedWsNumber = (value: unknown, key: string): number | undefined => {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const field = Reflect.get(value, key);

	return typeof field === 'number' ? field : undefined;
};

const getTrackedWsString = (value: unknown, key: string): string | undefined => {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const field = Reflect.get(value, key);

	return typeof field === 'string' ? field : undefined;
};

const isSameVoiceClientSession = (candidateWs: unknown, ownWs: unknown, ownClientInstanceId: string | undefined) => {
	if (candidateWs === ownWs) {
		return true;
	}

	if (!ownClientInstanceId) {
		return false;
	}

	const candidateClientInstanceId = getTrackedWsString(candidateWs, 'clientInstanceId');

	if (!candidateClientInstanceId) {
		return false;
	}

	return candidateClientInstanceId === ownClientInstanceId;
};

const logRestoreOrJoinEvent = (event: 'attempt' | 'conflict' | 'outcome', fields: Record<string, unknown>) => {
	logger.info(
		'[voice-reconnect] %s',
		JSON.stringify({
			scope: 'voice_restore_or_join',
			event,
			...fields,
		}),
	);
};

const wait = async (ms: number) => {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
};

const getReconnectLabFailureMessage = (code: 'INTERNAL_SERVER_ERROR' | 'UNAUTHORIZED' | 'CONFLICT' | undefined) => {
	switch (code) {
		case 'UNAUTHORIZED':
			return 'VOICE_RECONNECT_LAB_UNAUTHORIZED';
		case 'CONFLICT':
			return VOICE_SESSION_OWNED_ELSEWHERE;
		case 'INTERNAL_SERVER_ERROR':
		default:
			return 'VOICE_RECONNECT_LAB_FORCED_FAILURE';
	}
};

export { restoreOrJoinVoiceRoute, VOICE_SESSION_OWNED_ELSEWHERE, VOICE_SESSION_WRONG_CHANNEL };
