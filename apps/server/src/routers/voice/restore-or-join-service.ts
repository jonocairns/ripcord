import type { TVoiceUserState } from '@sharkord/shared';

const VOICE_SESSION_WRONG_CHANNEL = 'VOICE_SESSION_WRONG_CHANNEL';
const VOICE_SESSION_OWNED_ELSEWHERE = 'VOICE_SESSION_OWNED_ELSEWHERE';

type TVoiceRestoreConflictReason = typeof VOICE_SESSION_OWNED_ELSEWHERE | typeof VOICE_SESSION_WRONG_CHANNEL;

type TVoiceRestoreState = Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>;

type TVoiceRestoreSeat = {
	claim?: symbol;
	added: boolean;
	previousState?: TVoiceUserState;
};

type TVoiceRestoreRuntime = {
	id: number;
	addUser: (userId: number, state: TVoiceRestoreState) => void;
	acquireRestoreSeat: (userId: number, state: TVoiceRestoreState, inheritedClaim?: symbol) => TVoiceRestoreSeat;
	adoptProvisionalRestoreSeat: (userId: number) => symbol | undefined;
	commitProvisionalRestoreSeat: (userId: number, claim: symbol) => boolean;
	getUserState: (userId: number) => TVoiceUserState;
	getVoiceSessionIncarnation: (userId: number) => symbol | undefined;
	ownsProvisionalRestoreSeatClaim: (userId: number, claim: symbol) => boolean;
	rollbackProvisionalRestoreSeat: (userId: number, claim: symbol) => boolean;
};

type TPreparedVoiceBootstrap<TBootstrap> = {
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
			type: 'leave';
			channelId: number;
			userId: number;
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
	logRestoreEvent: (event: TVoiceRestoreLogEvent, fields: Record<string, unknown>) => void;
	logJoined: (userName: string, channelName: string) => void;
	logBootstrapRollback: (userName: string, channelName: string, error: unknown) => void;
};

class VoiceRestoreAttemptCancelledError extends Error {
	constructor() {
		super('Voice restore attempt cancelled');
		this.name = 'VoiceRestoreAttemptCancelledError';
	}
}

class VoiceRestoreAttemptSupersededServiceError extends Error {
	constructor() {
		super('Voice restore attempt superseded');
		this.name = 'VoiceRestoreAttemptSupersededServiceError';
	}
}

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

type TVoiceRestoreAttemptStatus = 'current' | 'cancelled' | 'superseded';

type TVoiceRestoreAttempt = {
	status: TVoiceRestoreAttemptStatus;
};

type TVoiceRestoreAttemptContext = {
	assertCurrent: () => void;
};

const createVoiceRestoreOrJoinService = <TRuntime extends TVoiceRestoreRuntime, TBootstrap>(
	dependencies: TVoiceRestoreOrJoinServiceDependencies<TRuntime, TBootstrap>,
) => {
	const latestAttemptByOwner = new Map<unknown, TVoiceRestoreAttempt>();

	const runLatestAttempt = async <T>(
		owner: unknown,
		signal: AbortSignal | undefined,
		run: (context: TVoiceRestoreAttemptContext) => Promise<T>,
	): Promise<T> => {
		const previousAttempt = latestAttemptByOwner.get(owner);

		// Preserve the first invalidation cause. A predecessor already cancelled by
		// its request signal stays cancelled when a successor later starts.
		if (previousAttempt?.status === 'current') {
			previousAttempt.status = 'superseded';
		}

		const attempt: TVoiceRestoreAttempt = { status: 'current' };
		latestAttemptByOwner.set(owner, attempt);

		const cancel = () => {
			if (attempt.status !== 'current') {
				return;
			}

			attempt.status = 'cancelled';

			if (latestAttemptByOwner.get(owner) === attempt) {
				latestAttemptByOwner.delete(owner);
			}
		};

		if (signal?.aborted) {
			cancel();
		} else {
			signal?.addEventListener('abort', cancel, { once: true });
		}

		const getStatus = (): TVoiceRestoreAttemptStatus => {
			if (attempt.status === 'current' && signal?.aborted) {
				cancel();
			}

			if (attempt.status === 'current' && latestAttemptByOwner.get(owner) !== attempt) {
				attempt.status = 'superseded';
			}

			return attempt.status;
		};

		const getInterruptionError = () => {
			switch (getStatus()) {
				case 'cancelled':
					return new VoiceRestoreAttemptCancelledError();
				case 'superseded':
					return new VoiceRestoreAttemptSupersededServiceError();
				case 'current':
					return undefined;
			}
		};

		const context: TVoiceRestoreAttemptContext = {
			assertCurrent: () => {
				const interruptionError = getInterruptionError();

				if (interruptionError) {
					throw interruptionError;
				}
			},
		};

		try {
			return await run(context);
		} finally {
			signal?.removeEventListener('abort', cancel);

			if (latestAttemptByOwner.get(owner) === attempt) {
				latestAttemptByOwner.delete(owner);
			}
		}
	};

	const restoreOrJoin = async (request: TVoiceRestoreOrJoinRequest<TRuntime>): Promise<TBootstrap> => {
		const { channelId, state, reconnectAttemptId, user, signal, context } = request;
		const clientInstanceId = context.getClientInstanceId();
		const attemptOwner = clientInstanceId
			? `${user.id}:${clientInstanceId}`
			: (context.getOwnConnection()?.identity ?? `${user.id}:unknown-client`);
		// Transfer cleanup ownership before registering the successor. Both actions
		// are synchronous, so the predecessor cannot roll the provisional seat back
		// between adoption and supersession.
		const inheritedSeatRuntime = dependencies.findRuntimeByChannelId(channelId);
		const inheritedSeatClaim = inheritedSeatRuntime?.adoptProvisionalRestoreSeat(user.id);

		try {
			return await runLatestAttempt(attemptOwner, signal, async (attempt) => {
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
							throw new VoiceRestoreAttemptSupersededServiceError();
						}

						// There is deliberately no await from the final currency/seat checks
						// through transport, membership, binding, and presence publication.
						preparedBootstrap.commit();
						ownershipTransferred = true;
						runtime.addUser(user.id, state);

						const sessionIncarnation = runtime.getVoiceSessionIncarnation(user.id);

						if (sessionIncarnation === undefined) {
							throw new Error('Fresh voice restore did not create a session incarnation');
						}

						const currentState = runtime.getUserState(user.id);
						context.bindVoiceSession(channel.id, sessionIncarnation);
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

				const seat = runtime.acquireRestoreSeat(user.id, state, inheritedSeatClaim);
				const currentState = runtime.getUserState(user.id);
				const restoredSeatIncarnation = runtime.getVoiceSessionIncarnation(user.id);
				let preparedBootstrap: TPreparedVoiceBootstrap<TBootstrap> | undefined;
				let ownershipTransferred = false;

				try {
					if (restoredSeatIncarnation === undefined) {
						throw new Error('Existing voice restore did not retain a session incarnation');
					}

					if (seat.added) {
						context.publishPresence({
							type: 'join',
							channelId,
							userId: user.id,
							state: currentState,
							reconnecting: true,
						});
						dependencies.logJoined(user.name, channel.name);
					} else if (
						seat.previousState &&
						(seat.previousState.micMuted !== state.micMuted || seat.previousState.soundMuted !== state.soundMuted)
					) {
						context.publishPresence({
							type: 'state-update',
							channelId,
							userId: user.id,
							state: currentState,
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
						runtime.getVoiceSessionIncarnation(user.id) !== restoredSeatIncarnation
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

						throw new VoiceRestoreAttemptSupersededServiceError();
					}

					if (seat.claim && !runtime.ownsProvisionalRestoreSeatClaim(user.id, seat.claim)) {
						throw new VoiceRestoreAttemptSupersededServiceError();
					}

					// There is deliberately no await from the final attempt, seat, and claim
					// checks through pair installation, claim transition, and binding.
					preparedBootstrap.commit();
					ownershipTransferred = true;

					if (seat.claim && !runtime.commitProvisionalRestoreSeat(user.id, seat.claim)) {
						throw new Error('Existing voice restore lost its provisional seat claim during commit');
					}

					// Binding also clears disconnect grace in the production adapter.
					context.bindVoiceSession(channel.id, restoredSeatIncarnation);

					const bootstrap = preparedBootstrap.buildCommittedResponse();

					dependencies.logRestoreEvent('outcome', {
						reconnectAttemptId,
						userId: user.id,
						clientInstanceId,
						requestedChannelId: channelId,
						activeChannelId: channelId,
						outcome: seat.added ? 'joined' : 'restored',
					});

					return bootstrap;
				} catch (error) {
					if (!ownershipTransferred && seat.claim && runtime.rollbackProvisionalRestoreSeat(user.id, seat.claim)) {
						context.publishPresence({
							type: 'leave',
							channelId,
							userId: user.id,
							reconnecting: true,
						});
						dependencies.logBootstrapRollback(user.name, channel.name, error);
					}

					throw error;
				} finally {
					if (preparedBootstrap && !ownershipTransferred) {
						await preparedBootstrap.dispose();
					}
				}
			});
		} catch (error) {
			// Before acquireRestoreSeat takes responsibility, the synchronously
			// inherited claim still belongs to this attempt. Claim identity makes this
			// cleanup a no-op after acquisition, commit, rollback, or successor adoption.
			if (inheritedSeatClaim && inheritedSeatRuntime?.rollbackProvisionalRestoreSeat(user.id, inheritedSeatClaim)) {
				context.publishPresence({
					type: 'leave',
					channelId,
					userId: user.id,
					reconnecting: true,
				});
			}

			throw error;
		}
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
