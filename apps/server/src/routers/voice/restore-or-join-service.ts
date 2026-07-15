import type { TVoiceUserState } from '@sharkord/shared';
import {
	createVoiceSessionAttemptRegistry,
	getVoiceSessionAttemptOwner,
	type TVoiceSessionAttemptRegistry,
	VoiceSessionAttemptCancelledError,
	VoiceSessionAttemptSupersededError,
} from './session-attempt-registry';

const VOICE_SESSION_WRONG_CHANNEL = 'VOICE_SESSION_WRONG_CHANNEL';
const VOICE_SESSION_OWNED_ELSEWHERE = 'VOICE_SESSION_OWNED_ELSEWHERE';

type TVoiceRestoreConflictReason = typeof VOICE_SESSION_OWNED_ELSEWHERE | typeof VOICE_SESSION_WRONG_CHANNEL;

type TVoiceRestoreState = Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>;

type TVoiceRestoreSessionIdentity = {
	incarnation: symbol;
	mutationToken: symbol;
};

type TVoiceRestoreStateReconciliation = {
	previousState: TVoiceUserState;
	currentState: TVoiceUserState;
	sessionIdentity: TVoiceRestoreSessionIdentity;
};

type TVoiceRestoreRuntime = {
	id: number;
	addUser: (userId: number, state: TVoiceRestoreState) => void;
	getUserState: (userId: number) => TVoiceUserState;
	getVoiceSessionIdentity: (userId: number) => TVoiceRestoreSessionIdentity | undefined;
	isVoiceSessionIdentityCurrent: (userId: number, identity: TVoiceRestoreSessionIdentity) => boolean;
	reconcileVoiceRestoreState: (
		userId: number,
		state: TVoiceRestoreState,
	) => TVoiceRestoreStateReconciliation | undefined;
};

type TPreparedVoiceBootstrap<TBootstrap> = {
	assertCommittable: () => void;
	commit: () => void;
	dispose: () => void | Promise<void>;
	buildCommittedResponse: () => TBootstrap;
};

type TVoiceRestoreConnection = {
	identity: unknown;
	clientInstanceId?: string;
	currentVoiceChannelId?: number;
};

type TVoiceReconnectLabRestoreBehavior = {
	delayMs?: number;
	failCode?: 'INTERNAL_SERVER_ERROR' | 'UNAUTHORIZED' | 'CONFLICT';
	failMessage?: string;
	closeWsCode?: number;
	closeWsReason?: string;
};

type TVoiceRestorePresenceEvent =
	| {
			type: 'join';
			channelId: number;
			userId: number;
			state: TVoiceUserState;
			reconnecting: true;
	  }
	| {
			type: 'state-update';
			channelId: number;
			userId: number;
			state: TVoiceUserState;
	  };

type TVoiceRestoreRequestContext<TRuntime extends TVoiceRestoreRuntime> = {
	resolveTarget: (channelId: number) => Promise<{
		channel: { id: number; name: string };
		runtime: TRuntime;
	}>;
	getClientInstanceId: () => string | undefined;
	getOwnConnection: () => TVoiceRestoreConnection | undefined;
	getUserConnections: (userId: number) => TVoiceRestoreConnection[];
	closeOwnConnection: (code: number, reason: string) => void;
	bindVoiceSession: (channelId: number, sessionIncarnation: symbol) => void;
	publishPresence: (event: TVoiceRestorePresenceEvent) => void;
};

type TVoiceRestoreOrJoinRequest<TRuntime extends TVoiceRestoreRuntime> = {
	channelId: number;
	state: TVoiceRestoreState;
	reconnectAttemptId: string;
	user: {
		id: number;
		name: string;
	};
	signal?: AbortSignal;
	context: TVoiceRestoreRequestContext<TRuntime>;
};

type TVoiceRestoreLogEvent = 'attempt' | 'conflict' | 'outcome';

type TVoiceRestoreOrJoinServiceDependencies<TRuntime extends TVoiceRestoreRuntime, TBootstrap> = {
	findRuntimeByChannelId: (channelId: number) => TRuntime | undefined;
	findRuntimeByUserId: (userId: number) => TRuntime | undefined;
	getPendingVoiceChannelIdsOwnedElsewhere: (userId: number, clientInstanceId?: string) => number[];
	consumeReconnectLabBehavior: (userId: number) => TVoiceReconnectLabRestoreBehavior | undefined;
	delay: (milliseconds: number) => Promise<void>;
	prepareBootstrap: (options: { runtime: TRuntime; userId: number }) => Promise<TPreparedVoiceBootstrap<TBootstrap>>;
	attemptRegistry?: TVoiceSessionAttemptRegistry;
	logRestoreEvent: (event: TVoiceRestoreLogEvent, fields: Record<string, unknown>) => void;
	logJoined: (userName: string, channelName: string) => void;
};

class VoiceRestoreConflictError extends Error {
	public readonly reason: TVoiceRestoreConflictReason;

	constructor(reason: TVoiceRestoreConflictReason) {
		super(reason);
		this.name = 'VoiceRestoreConflictError';
		this.reason = reason;
	}
}

class VoiceReconnectLabRestoreError extends Error {
	public readonly code: 'INTERNAL_SERVER_ERROR' | 'UNAUTHORIZED' | 'CONFLICT';

	constructor(code: 'INTERNAL_SERVER_ERROR' | 'UNAUTHORIZED' | 'CONFLICT', message: string) {
		super(message);
		this.name = 'VoiceReconnectLabRestoreError';
		this.code = code;
	}
}

const createVoiceRestoreOrJoinService = <TRuntime extends TVoiceRestoreRuntime, TBootstrap>(
	dependencies: TVoiceRestoreOrJoinServiceDependencies<TRuntime, TBootstrap>,
) => {
	const attemptRegistry = dependencies.attemptRegistry ?? createVoiceSessionAttemptRegistry();

	const restoreOrJoin = async (request: TVoiceRestoreOrJoinRequest<TRuntime>): Promise<TBootstrap> => {
		const { channelId, state, reconnectAttemptId, user, signal, context } = request;
		const clientInstanceId = context.getClientInstanceId();
		const attemptOwner = getVoiceSessionAttemptOwner(user.id, clientInstanceId, context.getOwnConnection()?.identity);

		return attemptRegistry.runLatest(attemptOwner, { kind: 'restore', signal }, async (attempt) => {
			const { channel, runtime } = await context.resolveTarget(channelId);
			attempt.assertCurrent();

			const runtimeWithUser = dependencies.findRuntimeByUserId(user.id);
			const ownConnection = context.getOwnConnection();
			const otherActiveVoiceChannelIds = context.getUserConnections(user.id).flatMap((connection) => {
				if (isSameVoiceClientSession(connection, ownConnection, clientInstanceId)) {
					return [];
				}

				return connection.currentVoiceChannelId === undefined ? [] : [connection.currentVoiceChannelId];
			});
			const otherPendingVoiceChannelIds = dependencies.getPendingVoiceChannelIdsOwnedElsewhere(
				user.id,
				clientInstanceId,
			);
			const activeChannelId = runtimeWithUser?.id ?? otherActiveVoiceChannelIds[0] ?? otherPendingVoiceChannelIds[0];
			const hasOtherSessionInRequestedChannel =
				otherActiveVoiceChannelIds.includes(channelId) || otherPendingVoiceChannelIds.includes(channelId);

			dependencies.logRestoreEvent('attempt', {
				reconnectAttemptId,
				userId: user.id,
				clientInstanceId,
				requestedChannelId: channelId,
				activeChannelId,
			});

			if (hasOtherSessionInRequestedChannel) {
				logConflict(dependencies, request, clientInstanceId, channelId, VOICE_SESSION_OWNED_ELSEWHERE);
				throw new VoiceRestoreConflictError(VOICE_SESSION_OWNED_ELSEWHERE);
			}

			if (activeChannelId !== undefined && activeChannelId !== channelId) {
				logConflict(dependencies, request, clientInstanceId, activeChannelId, VOICE_SESSION_WRONG_CHANNEL);
				throw new VoiceRestoreConflictError(VOICE_SESSION_WRONG_CHANNEL);
			}

			const reconnectLabBehavior = dependencies.consumeReconnectLabBehavior(user.id);

			if (reconnectLabBehavior?.delayMs) {
				await dependencies.delay(reconnectLabBehavior.delayMs);
				attempt.assertCurrent();
			}

			if (reconnectLabBehavior?.closeWsCode) {
				context.closeOwnConnection(
					reconnectLabBehavior.closeWsCode,
					reconnectLabBehavior.closeWsReason ?? 'voice reconnect lab',
				);

				throw new VoiceReconnectLabRestoreError('INTERNAL_SERVER_ERROR', 'VOICE_RECONNECT_LAB_SOCKET_CLOSED');
			}

			if (reconnectLabBehavior?.failCode || reconnectLabBehavior?.failMessage) {
				const failCode = reconnectLabBehavior.failCode ?? 'INTERNAL_SERVER_ERROR';

				throw new VoiceReconnectLabRestoreError(
					failCode,
					reconnectLabBehavior.failMessage ?? getReconnectLabFailureMessage(failCode),
				);
			}

			attempt.assertCurrent();

			// Target and reconnect-lab work awaited above. A manual join can move the
			// user during that window and must win instead of being double-seated.
			const runtimeWithUserAfterAwaits = dependencies.findRuntimeByUserId(user.id);

			if (runtimeWithUserAfterAwaits && runtimeWithUserAfterAwaits.id !== channelId) {
				logConflict(
					dependencies,
					request,
					clientInstanceId,
					runtimeWithUserAfterAwaits.id,
					VOICE_SESSION_WRONG_CHANNEL,
				);
				throw new VoiceRestoreConflictError(VOICE_SESSION_WRONG_CHANNEL);
			}

			if (!runtimeWithUserAfterAwaits) {
				let preparedBootstrap: TPreparedVoiceBootstrap<TBootstrap> | undefined;
				let ownershipTransferred = false;

				try {
					preparedBootstrap = await dependencies.prepareBootstrap({
						runtime,
						userId: user.id,
					});
					attempt.assertCurrent();

					// Preparation is fallible and may take long enough for a manual join or
					// another client to establish a seat. Recheck synchronously beside the
					// currency assertion so this fresh attempt cannot replace that session.
					const runtimeWithUserBeforeCommit = dependencies.findRuntimeByUserId(user.id);

					if (runtimeWithUserBeforeCommit) {
						if (runtimeWithUserBeforeCommit.id !== channelId) {
							logConflict(
								dependencies,
								request,
								clientInstanceId,
								runtimeWithUserBeforeCommit.id,
								VOICE_SESSION_WRONG_CHANNEL,
							);
							throw new VoiceRestoreConflictError(VOICE_SESSION_WRONG_CHANNEL);
						}

						const ownConnectionBeforeCommit = context.getOwnConnection();
						const sessionOwnedElsewhere =
							context
								.getUserConnections(user.id)
								.some(
									(connection) =>
										!isSameVoiceClientSession(connection, ownConnectionBeforeCommit, clientInstanceId) &&
										connection.currentVoiceChannelId === channelId,
								) ||
							dependencies.getPendingVoiceChannelIdsOwnedElsewhere(user.id, clientInstanceId).includes(channelId);

						if (sessionOwnedElsewhere) {
							logConflict(dependencies, request, clientInstanceId, channelId, VOICE_SESSION_OWNED_ELSEWHERE);
							throw new VoiceRestoreConflictError(VOICE_SESSION_OWNED_ELSEWHERE);
						}

						// A same-client manual join completed while this request prepared. It
						// must win even though it does not participate in this attempt registry.
						throw new VoiceSessionAttemptSupersededError();
					}

					// There is deliberately no await from the final currency/seat checks
					// through transport, membership, binding, and presence publication.
					preparedBootstrap.assertCommittable();
					preparedBootstrap.commit();
					ownershipTransferred = true;
					runtime.addUser(user.id, state);

					const sessionIdentity = runtime.getVoiceSessionIdentity(user.id);

					if (sessionIdentity === undefined) {
						throw new Error('Fresh voice restore did not create a session incarnation');
					}

					const currentState = runtime.getUserState(user.id);
					context.bindVoiceSession(channel.id, sessionIdentity.incarnation);
					context.publishPresence({
						type: 'join',
						channelId,
						userId: user.id,
						state: currentState,
						reconnecting: true,
					});
					dependencies.logJoined(user.name, channel.name);

					const bootstrap = preparedBootstrap.buildCommittedResponse();

					dependencies.logRestoreEvent('outcome', {
						reconnectAttemptId,
						userId: user.id,
						clientInstanceId,
						requestedChannelId: channelId,
						activeChannelId: channelId,
						outcome: 'joined',
					});

					return bootstrap;
				} finally {
					if (preparedBootstrap && !ownershipTransferred) {
						await preparedBootstrap.dispose();
					}
				}
			}

			const reconciliation = runtime.reconcileVoiceRestoreState(user.id, state);

			if (!reconciliation) {
				throw new VoiceSessionAttemptSupersededError();
			}

			let preparedBootstrap: TPreparedVoiceBootstrap<TBootstrap> | undefined;
			let ownershipTransferred = false;

			try {
				if (
					reconciliation.previousState.micMuted !== state.micMuted ||
					reconciliation.previousState.soundMuted !== state.soundMuted
				) {
					context.publishPresence({
						type: 'state-update',
						channelId,
						userId: user.id,
						state: reconciliation.currentState,
					});
				}

				preparedBootstrap = await dependencies.prepareBootstrap({
					runtime,
					userId: user.id,
				});
				attempt.assertCurrent();

				const runtimeWithUserBeforeCommit = dependencies.findRuntimeByUserId(user.id);

				if (
					runtimeWithUserBeforeCommit !== runtime ||
					!runtime.isVoiceSessionIdentityCurrent(user.id, reconciliation.sessionIdentity)
				) {
					if (runtimeWithUserBeforeCommit && runtimeWithUserBeforeCommit.id !== channelId) {
						logConflict(
							dependencies,
							request,
							clientInstanceId,
							runtimeWithUserBeforeCommit.id,
							VOICE_SESSION_WRONG_CHANNEL,
						);
						throw new VoiceRestoreConflictError(VOICE_SESSION_WRONG_CHANNEL);
					}

					throw new VoiceSessionAttemptSupersededError();
				}

				// There is deliberately no await from the final attempt and session
				// checks through pair installation and binding.
				preparedBootstrap.assertCommittable();
				preparedBootstrap.commit();
				ownershipTransferred = true;

				// Binding also clears disconnect grace in the production adapter.
				context.bindVoiceSession(channel.id, reconciliation.sessionIdentity.incarnation);

				const bootstrap = preparedBootstrap.buildCommittedResponse();

				dependencies.logRestoreEvent('outcome', {
					reconnectAttemptId,
					userId: user.id,
					clientInstanceId,
					requestedChannelId: channelId,
					activeChannelId: channelId,
					outcome: 'restored',
				});

				return bootstrap;
			} finally {
				if (preparedBootstrap && !ownershipTransferred) {
					await preparedBootstrap.dispose();
				}
			}
		});
	};

	return { restoreOrJoin };
};

const isSameVoiceClientSession = (
	candidate: TVoiceRestoreConnection,
	ownConnection: TVoiceRestoreConnection | undefined,
	ownClientInstanceId: string | undefined,
) => {
	if (candidate.identity === ownConnection?.identity) {
		return true;
	}

	if (!ownClientInstanceId || !candidate.clientInstanceId) {
		return false;
	}

	return candidate.clientInstanceId === ownClientInstanceId;
};

const logConflict = <TRuntime extends TVoiceRestoreRuntime, TBootstrap>(
	dependencies: TVoiceRestoreOrJoinServiceDependencies<TRuntime, TBootstrap>,
	request: TVoiceRestoreOrJoinRequest<TRuntime>,
	clientInstanceId: string | undefined,
	activeChannelId: number,
	reason: TVoiceRestoreConflictReason,
) => {
	dependencies.logRestoreEvent('conflict', {
		reconnectAttemptId: request.reconnectAttemptId,
		userId: request.user.id,
		clientInstanceId,
		requestedChannelId: request.channelId,
		activeChannelId,
		reason,
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

const VoiceRestoreAttemptCancelledError = VoiceSessionAttemptCancelledError;
const VoiceRestoreAttemptSupersededServiceError = VoiceSessionAttemptSupersededError;

export type {
	TVoiceReconnectLabRestoreBehavior,
	TVoiceRestoreConnection,
	TVoiceRestoreOrJoinRequest,
	TVoiceRestoreOrJoinServiceDependencies,
	TVoiceRestorePresenceEvent,
	TVoiceRestoreRequestContext,
	TVoiceRestoreRuntime,
};
export {
	createVoiceRestoreOrJoinService,
	VOICE_SESSION_OWNED_ELSEWHERE,
	VOICE_SESSION_WRONG_CHANNEL,
	VoiceReconnectLabRestoreError,
	VoiceRestoreAttemptCancelledError,
	VoiceRestoreAttemptSupersededServiceError,
	VoiceRestoreConflictError,
};
