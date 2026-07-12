import { ServerEvents } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { config } from '../../config';
import { logger } from '../../logger';
import { VoiceRestoreAttemptSupersededError, VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';
import { getPendingVoiceReconnectChannelIdsOwnedElsewhere } from '../../utils/voice-disconnect-grace';
import { createVoiceJoinBootstrap, getVoiceJoinTarget, voiceJoinInputSchema } from './bootstrap';
import { consumeVoiceReconnectLabNextRestoreBehavior } from './reconnect-lab-state';

const VOICE_SESSION_WRONG_CHANNEL = 'VOICE_SESSION_WRONG_CHANNEL';
const VOICE_SESSION_OWNED_ELSEWHERE = 'VOICE_SESSION_OWNED_ELSEWHERE';
const latestRestoreAttemptByOwner = new Map<unknown, symbol>();

const runLatestRestoreAttempt = async <T>(
	owner: unknown,
	signal: AbortSignal | undefined,
	run: (isCurrent: () => boolean) => Promise<T>,
): Promise<T> => {
	const attemptToken = Symbol('voice-restore-attempt');
	latestRestoreAttemptByOwner.set(owner, attemptToken);

	const isCurrent = () => latestRestoreAttemptByOwner.get(owner) === attemptToken && signal?.aborted !== true;
	const invalidate = () => {
		if (latestRestoreAttemptByOwner.get(owner) === attemptToken) {
			latestRestoreAttemptByOwner.delete(owner);
		}
	};

	signal?.addEventListener('abort', invalidate, { once: true });

	try {
		return await run(isCurrent);
	} finally {
		signal?.removeEventListener('abort', invalidate);
		invalidate();
	}
};

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
		const clientInstanceId = ctx.getClientInstanceId();
		const attemptOwner = clientInstanceId
			? `${ctx.user.id}:${clientInstanceId}`
			: (ctx.getOwnWs() ?? `${ctx.user.id}:unknown-client`);
		// Transfer a provisional seat synchronously, before the new attempt reaches
		// its first await. Otherwise the invalidated predecessor can finish its
		// transport bootstrap and roll the seat back while this request is still
		// checking permissions, leaving the successor with a bootstrap that omits
		// its own user.
		const inheritedSeatRuntime = VoiceRuntime.findById(input.channelId);
		const inheritedSeatClaim = inheritedSeatRuntime?.adoptProvisionalRestoreSeat(ctx.user.id);

		try {
			return await runLatestRestoreAttempt(attemptOwner, signal, async (isCurrent) => {
				const assertCurrent = (): void => {
					if (!isCurrent()) {
						throw new VoiceRestoreAttemptSupersededError();
					}
				};

				const { channel, runtime } = await getVoiceJoinTarget(ctx, input.channelId);
				assertCurrent();
				const runtimeWithUser = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
				const ownWs = ctx.getOwnWs();
				// Read the client instance id from the connection params (via ctx) rather
				// than the tracked WS. During a reconnect the tracked WS field can still be
				// unpopulated, which used to make restoreOrJoin misread the user's own
				// pending grace seat as owned by another device and reject the legit
				// reconnect with a terminal CONFLICT it could never recover from.
				const otherActiveVoiceChannelIds = ctx.getUserWss(ctx.user.id).flatMap((ws) => {
					if (isSameVoiceClientSession(ws, ownWs, clientInstanceId)) {
						return [];
					}

					const currentVoiceChannelId = getTrackedWsNumber(ws, 'currentVoiceChannelId');

					return currentVoiceChannelId === undefined ? [] : [currentVoiceChannelId];
				});
				const otherPendingVoiceChannelIds = getPendingVoiceReconnectChannelIdsOwnedElsewhere(
					ctx.user.id,
					clientInstanceId,
				);
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
					assertCurrent();
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

				assertCurrent();

				// The conflict checks above ran before the lab delay and the awaits in
				// getVoiceJoinTarget. A manual voice.join can move this user to another
				// channel inside that window; re-seating them here would leave a ghost
				// seat in the channel they just left and rebind this connection to it.
				const runtimeWithUserAfterAwaits = VoiceRuntime.findRuntimeByUserId(ctx.user.id);

				if (runtimeWithUserAfterAwaits && runtimeWithUserAfterAwaits.id !== input.channelId) {
					logRestoreOrJoinEvent('conflict', {
						reconnectAttemptId: input.reconnectAttemptId,
						userId: ctx.user.id,
						clientInstanceId,
						requestedChannelId: input.channelId,
						activeChannelId: runtimeWithUserAfterAwaits.id,
						reason: VOICE_SESSION_WRONG_CHANNEL,
					});

					throw new TRPCError({
						code: 'CONFLICT',
						message: VOICE_SESSION_WRONG_CHANNEL,
					});
				}

				const seat = runtime.acquireRestoreSeat(ctx.user.id, input.state, inheritedSeatClaim);
				const state = runtime.getUserState(ctx.user.id);

				if (seat.added) {
					ctx.pubsub.publish(ServerEvents.USER_JOIN_VOICE, {
						channelId: input.channelId,
						userId: ctx.user.id,
						state,
						reconnecting: true,
					});

					logger.info('%s restoreOrJoin joined voice channel %s', ctx.user.name, channel.name);
				} else if (
					seat.previousState &&
					(seat.previousState.micMuted !== input.state.micMuted ||
						seat.previousState.soundMuted !== input.state.soundMuted)
				) {
					ctx.pubsub.publish(ServerEvents.USER_VOICE_STATE_UPDATE, {
						channelId: input.channelId,
						userId: ctx.user.id,
						state,
					});
				}

				let bootstrap: Awaited<ReturnType<typeof createVoiceJoinBootstrap>>;

				try {
					bootstrap = await createVoiceJoinBootstrap({
						runtime,
						userId: ctx.user.id,
						isCurrent,
					});
					assertCurrent();

					if (seat.claim) {
						runtime.commitProvisionalRestoreSeat(ctx.user.id, seat.claim);
					}

					// Binding the new websocket clears the old disconnect-grace timer. Do
					// this only after bootstrap commits; otherwise a failed restore of a
					// surviving seat cancels its only cleanup path and leaves a ghost user.
					// A concurrent manual join can also move the seat away while the
					// bootstrap was in flight — binding then would point this connection
					// at a channel it no longer occupies, so require a live incarnation.
					const restoredSeatIncarnation = runtime.getVoiceSessionIncarnation(ctx.user.id);

					if (restoredSeatIncarnation !== undefined) {
						ctx.currentVoiceChannelId = channel.id;
						ctx.currentVoiceSessionIncarnation = restoredSeatIncarnation;
						ctx.setWsVoiceChannelId(channel.id);
					}
				} catch (error) {
					if (seat.claim && runtime.rollbackProvisionalRestoreSeat(ctx.user.id, seat.claim)) {
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
					}

					throw error;
				}

				logRestoreOrJoinEvent('outcome', {
					reconnectAttemptId: input.reconnectAttemptId,
					userId: ctx.user.id,
					clientInstanceId,
					requestedChannelId: input.channelId,
					activeChannelId: input.channelId,
					outcome: seat.added ? 'joined' : 'restored',
				});

				return bootstrap;
			});
		} catch (error) {
			// If this attempt failed before acquireRestoreSeat took responsibility for
			// the inherited lease, it still owns cleanup. After commit or a later
			// adoption this is intentionally a no-op.
			if (inheritedSeatClaim && inheritedSeatRuntime?.rollbackProvisionalRestoreSeat(ctx.user.id, inheritedSeatClaim)) {
				ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
					channelId: input.channelId,
					userId: ctx.user.id,
					reconnecting: true,
				});
			}

			throw error;
		}
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
