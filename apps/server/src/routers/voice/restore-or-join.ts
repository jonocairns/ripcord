import { ServerEvents } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { config } from '../../config';
import { logger } from '../../logger';
import { VoiceRestoreAttemptSupersededError, VoiceRuntime } from '../../runtimes/voice';
import { type Context, protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';
import { getPendingVoiceReconnectChannelIdsOwnedElsewhere } from '../../utils/voice-disconnect-grace';
import { getVoiceJoinTarget, prepareVoiceJoinBootstrap, voiceJoinInputSchema } from './bootstrap';
import { consumeVoiceReconnectLabNextRestoreBehavior } from './reconnect-lab-state';
import {
	createVoiceRestoreOrJoinService,
	type TVoiceRestoreConnection,
	type TVoiceRestorePresenceEvent,
	VOICE_SESSION_OWNED_ELSEWHERE,
	VOICE_SESSION_WRONG_CHANNEL,
	VoiceReconnectLabRestoreError,
	VoiceRestoreAttemptCancelledError,
	VoiceRestoreAttemptSupersededServiceError,
	VoiceRestoreConflictError,
} from './restore-or-join-service';
import { voiceSessionAttemptRegistry } from './session-attempt-registry';

const restoreOrJoinService = createVoiceRestoreOrJoinService({
	findRuntimeByChannelId: VoiceRuntime.findById,
	findRuntimeByUserId: VoiceRuntime.findRuntimeByUserId,
	getPendingVoiceChannelIdsOwnedElsewhere: getPendingVoiceReconnectChannelIdsOwnedElsewhere,
	consumeReconnectLabBehavior: consumeVoiceReconnectLabNextRestoreBehavior,
	delay: wait,
	prepareBootstrap: prepareVoiceJoinBootstrap,
	attemptRegistry: voiceSessionAttemptRegistry,
	logRestoreEvent: logRestoreOrJoinEvent,
	logJoined: (userName, channelName) => {
		logger.info('%s restoreOrJoin joined voice channel %s', userName, channelName);
	},
});

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
	.mutation(async ({ input, ctx, signal }) => {
		try {
			return await restoreOrJoinService.restoreOrJoin({
				channelId: input.channelId,
				state: input.state,
				reconnectAttemptId: input.reconnectAttemptId,
				user: ctx.user,
				signal,
				context: createVoiceRestoreRequestContext(ctx),
			});
		} catch (error) {
			throw toRestoreOrJoinPublicError(error);
		}
	});

const toRestoreOrJoinPublicError = (error: unknown): unknown => {
	if (
		error instanceof VoiceRestoreAttemptCancelledError ||
		error instanceof VoiceRestoreAttemptSupersededServiceError
	) {
		return new VoiceRestoreAttemptSupersededError();
	}

	if (error instanceof VoiceRestoreConflictError) {
		return new TRPCError({
			code: 'CONFLICT',
			message: error.reason,
		});
	}

	if (error instanceof VoiceReconnectLabRestoreError) {
		return new TRPCError({
			code: error.code,
			message: error.message,
		});
	}

	return error;
};

const createVoiceRestoreRequestContext = (ctx: Context) => ({
	resolveTarget: (channelId: number) => getVoiceJoinTarget(ctx, channelId),
	getClientInstanceId: ctx.getClientInstanceId,
	getOwnConnection: () => toVoiceRestoreConnection(ctx.getOwnWs()),
	getUserConnections: (userId: number) =>
		ctx.getUserWss(userId).flatMap((connection) => {
			const voiceConnection = toVoiceRestoreConnection(connection);

			return voiceConnection ? [voiceConnection] : [];
		}),
	closeOwnConnection: (code: number, reason: string) => {
		ctx.getOwnWs()?.close(code, reason);
	},
	bindVoiceSession: (channelId: number, sessionIncarnation: symbol) => {
		ctx.currentVoiceChannelId = channelId;
		ctx.currentVoiceSessionIncarnation = sessionIncarnation;
		ctx.setWsVoiceChannelId(channelId);
	},
	publishPresence: (event: TVoiceRestorePresenceEvent) => publishVoiceRestorePresence(ctx, event),
});

const toVoiceRestoreConnection = (connection: unknown): TVoiceRestoreConnection | undefined => {
	if (connection === undefined) {
		return undefined;
	}

	return {
		identity: connection,
		clientInstanceId: getTrackedWsString(connection, 'clientInstanceId'),
		currentVoiceChannelId: getTrackedWsNumber(connection, 'currentVoiceChannelId'),
	};
};

const publishVoiceRestorePresence = (ctx: Context, event: TVoiceRestorePresenceEvent) => {
	switch (event.type) {
		case 'join':
			ctx.pubsub.publish(ServerEvents.USER_JOIN_VOICE, {
				channelId: event.channelId,
				userId: event.userId,
				state: event.state,
				reconnecting: event.reconnecting,
			});
			return;
		case 'state-update':
			ctx.pubsub.publish(ServerEvents.USER_VOICE_STATE_UPDATE, {
				channelId: event.channelId,
				userId: event.userId,
				state: event.state,
			});
	}
};

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

function logRestoreOrJoinEvent(event: 'attempt' | 'conflict' | 'outcome', fields: Record<string, unknown>) {
	logger.info(
		'[voice-reconnect] %s',
		JSON.stringify({
			scope: 'voice_restore_or_join',
			event,
			...fields,
		}),
	);
}

async function wait(ms: number) {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export {
	restoreOrJoinVoiceRoute,
	toRestoreOrJoinPublicError,
	VOICE_SESSION_OWNED_ELSEWHERE,
	VOICE_SESSION_WRONG_CHANNEL,
};
