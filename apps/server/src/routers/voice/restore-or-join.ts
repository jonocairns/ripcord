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

		return runLatestRestoreAttempt(attemptOwner, signal, async (isCurrent) => {
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

			if (runtimeWithUser?.id === input.channelId) {
				assertCurrent();
				const provisionalSeatClaim = runtime.adoptProvisionalRestoreSeat(ctx.user.id);
				ctx.currentVoiceChannelId = input.channelId;
				ctx.setWsVoiceChannelId(input.channelId);

				try {
					const bootstrap = await createVoiceJoinBootstrap({
						runtime,
						userId: ctx.user.id,
						isCurrent,
					});
					assertCurrent();
					if (provisionalSeatClaim) {
						runtime.commitProvisionalRestoreSeat(ctx.user.id, provisionalSeatClaim);
					}

					logRestoreOrJoinEvent('outcome', {
						reconnectAttemptId: input.reconnectAttemptId,
						userId: ctx.user.id,
						clientInstanceId,
						requestedChannelId: input.channelId,
						activeChannelId: input.channelId,
						outcome: 'restored',
					});

					return bootstrap;
				} catch (error) {
					if (provisionalSeatClaim && runtime.rollbackProvisionalRestoreSeat(ctx.user.id, provisionalSeatClaim)) {
						ctx.currentVoiceChannelId = undefined;
						ctx.setWsVoiceChannelId(undefined);
						ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
							channelId: input.channelId,
							userId: ctx.user.id,
							reconnecting: true,
						});
					}

					throw error;
				}
			}

			assertCurrent();
			runtime.addUser(ctx.user.id, input.state);
			const provisionalSeatClaim = runtime.beginProvisionalRestoreSeat(ctx.user.id);

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

			let bootstrap: Awaited<ReturnType<typeof createVoiceJoinBootstrap>>;

			try {
				bootstrap = await createVoiceJoinBootstrap({
					runtime,
					userId: ctx.user.id,
					isCurrent,
				});
				assertCurrent();
				runtime.commitProvisionalRestoreSeat(ctx.user.id, provisionalSeatClaim);
			} catch (error) {
				if (runtime.rollbackProvisionalRestoreSeat(ctx.user.id, provisionalSeatClaim)) {
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
				}

				throw error;
			}

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
