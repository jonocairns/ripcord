import type { TVoiceUserState } from '@sharkord/shared';
import {
	createVoiceSessionAttemptRegistry,
	getVoiceSessionAttemptOwner,
	type TVoiceSessionAttemptRegistry,
} from './session-attempt-registry';

type TVoiceJoinState = Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>;

type TVoiceJoinSessionIdentity = {
	incarnation: symbol;
	mutationToken: symbol;
};

type TVoiceJoinRuntime = {
	id: number;
	addUser: (userId: number, state: TVoiceJoinState) => void;
	getUserState: (userId: number) => TVoiceUserState;
	getVoiceSessionIdentity: (userId: number) => TVoiceJoinSessionIdentity | undefined;
	isVoiceSessionIdentityCurrent: (userId: number, identity: TVoiceJoinSessionIdentity) => boolean;
	removeUserIfSessionMatches: (userId: number, sessionIncarnation: symbol | undefined) => boolean;
};

type TPreparedVoiceJoin<TBootstrap> = {
	assertCommittable: () => void;
	commit: () => void;
	dispose: () => void | Promise<void>;
	buildCommittedResponse: () => TBootstrap;
};

type TVoiceJoinBinding = {
	channelId?: number;
	sessionIncarnation?: symbol;
};

type TVoiceJoinPresenceEvent =
	| {
			type: 'leave';
			channelId: number;
			userId: number;
			reconnecting: boolean;
	  }
	| {
			type: 'session-replaced';
			channelId: number;
			userId: number;
			replacedByClientInstanceId?: string;
	  }
	| {
			type: 'join';
			channelId: number;
			userId: number;
			state: TVoiceUserState;
			reconnecting: boolean;
	  };

type TVoiceJoinRequestContext<TRuntime extends TVoiceJoinRuntime> = {
	resolveTarget: (channelId: number) => Promise<{
		channel: { id: number; name: string };
		runtime: TRuntime;
	}>;
	getClientInstanceId: () => string | undefined;
	getConnectionIdentity: () => unknown;
	registerMutation: (mutationSeq: number | undefined) => boolean;
	isMutationCurrent: (mutationSeq: number | undefined) => boolean;
	getBinding: () => TVoiceJoinBinding;
	bindVoiceSession: (channelId: number, sessionIncarnation: symbol) => void;
	clearBindingIfMatches: (binding: TVoiceJoinBinding) => void;
	publishPresence: (event: TVoiceJoinPresenceEvent) => void;
};

type TVoiceJoinRequest<TRuntime extends TVoiceJoinRuntime> = {
	channelId: number;
	state: TVoiceJoinState;
	mutationSeq?: number;
	user: {
		id: number;
		name: string;
	};
	signal?: AbortSignal;
	context: TVoiceJoinRequestContext<TRuntime>;
};

type TVoiceJoinServiceDependencies<TRuntime extends TVoiceJoinRuntime, TBootstrap> = {
	findRuntimeByChannelId: (channelId: number) => TRuntime | undefined;
	findRuntimeByUserId: (userId: number) => TRuntime | undefined;
	prepareBootstrap: (options: { runtime: TRuntime; userId: number }) => Promise<TPreparedVoiceJoin<TBootstrap>>;
	attemptRegistry?: TVoiceSessionAttemptRegistry;
	logJoined: (userName: string, channelName: string) => void;
	logReplaced: (userName: string, channelId: number) => void;
};

class VoiceJoinSupersededError extends Error {
	constructor() {
		super('Voice join superseded by a newer voice mutation');
		this.name = 'VoiceJoinSupersededError';
	}
}

const createVoiceJoinService = <TRuntime extends TVoiceJoinRuntime, TBootstrap>(
	dependencies: TVoiceJoinServiceDependencies<TRuntime, TBootstrap>,
) => {
	const attemptRegistry = dependencies.attemptRegistry ?? createVoiceSessionAttemptRegistry();

	const join = async (request: TVoiceJoinRequest<TRuntime>): Promise<TBootstrap> => {
		const { channelId, state, mutationSeq, user, signal, context } = request;

		if (!context.registerMutation(mutationSeq)) {
			throw new VoiceJoinSupersededError();
		}

		const clientInstanceId = context.getClientInstanceId();
		const attemptOwner = getVoiceSessionAttemptOwner(user.id, clientInstanceId, context.getConnectionIdentity());

		return attemptRegistry.runLatest(attemptOwner, signal, async (attempt) => {
			attempt.assertCurrent();
			assertMutationCurrent(context, mutationSeq);

			const { channel, runtime } = await context.resolveTarget(channelId);
			attempt.assertCurrent();
			assertMutationCurrent(context, mutationSeq);

			const oldRuntime = dependencies.findRuntimeByUserId(user.id);
			const oldSessionIdentity = oldRuntime?.getVoiceSessionIdentity(user.id);

			if (oldRuntime && !oldSessionIdentity) {
				throw new VoiceJoinSupersededError();
			}

			const capturedBinding = context.getBinding();
			const isReconnecting = oldRuntime?.id === channelId;
			let preparedBootstrap: TPreparedVoiceJoin<TBootstrap> | undefined;
			let ownershipTransferred = false;
			let oldSeatRemoved = false;

			try {
				preparedBootstrap = await dependencies.prepareBootstrap({ runtime, userId: user.id });
				attempt.assertCurrent();
				assertMutationCurrent(context, mutationSeq);

				if (dependencies.findRuntimeByChannelId(channelId) !== runtime) {
					throw new VoiceJoinSupersededError();
				}

				const currentRuntime = dependencies.findRuntimeByUserId(user.id);

				if (oldRuntime) {
					if (
						currentRuntime !== oldRuntime ||
						!oldSessionIdentity ||
						!oldRuntime.isVoiceSessionIdentityCurrent(user.id, oldSessionIdentity)
					) {
						throw new VoiceJoinSupersededError();
					}
				} else if (currentRuntime) {
					throw new VoiceJoinSupersededError();
				}

				if (!bindingsMatch(context.getBinding(), capturedBinding)) {
					throw new VoiceJoinSupersededError();
				}

				preparedBootstrap.assertCommittable();

				if (oldRuntime && oldSessionIdentity) {
					// The identity checks above and this removal are in the same turn. Mark
					// the fail-closed path first so even an unexpected synchronous cleanup
					// exception cannot leave the old binding published as live.
					oldSeatRemoved = true;

					if (!oldRuntime.removeUserIfSessionMatches(user.id, oldSessionIdentity.incarnation)) {
						oldSeatRemoved = false;
						throw new VoiceJoinSupersededError();
					}
				}

				preparedBootstrap.commit();
				ownershipTransferred = true;
				runtime.addUser(user.id, state);

				const newSessionIdentity = runtime.getVoiceSessionIdentity(user.id);

				if (!newSessionIdentity) {
					throw new Error('Committed voice join did not create a session incarnation');
				}

				const currentState = runtime.getUserState(user.id);
				context.bindVoiceSession(channel.id, newSessionIdentity.incarnation);

				if (oldRuntime) {
					context.publishPresence({
						type: 'leave',
						channelId: oldRuntime.id,
						userId: user.id,
						reconnecting: isReconnecting,
					});
					context.publishPresence({
						type: 'session-replaced',
						channelId: oldRuntime.id,
						userId: user.id,
						replacedByClientInstanceId: clientInstanceId,
					});
					dependencies.logReplaced(user.name, oldRuntime.id);
				}

				context.publishPresence({
					type: 'join',
					channelId,
					userId: user.id,
					state: currentState,
					reconnecting: isReconnecting,
				});
				dependencies.logJoined(user.name, channel.name);

				return preparedBootstrap.buildCommittedResponse();
			} catch (error) {
				if (oldSeatRemoved && !ownershipTransferred) {
					context.clearBindingIfMatches(capturedBinding);
					context.publishPresence({
						type: 'leave',
						channelId: oldRuntime?.id ?? channelId,
						userId: user.id,
						reconnecting: isReconnecting,
					});
				}

				throw error;
			} finally {
				if (preparedBootstrap && !ownershipTransferred) {
					await preparedBootstrap.dispose();
				}
			}
		});
	};

	return { join };
};

const assertMutationCurrent = <TRuntime extends TVoiceJoinRuntime>(
	context: TVoiceJoinRequestContext<TRuntime>,
	mutationSeq: number | undefined,
) => {
	if (!context.isMutationCurrent(mutationSeq)) {
		throw new VoiceJoinSupersededError();
	}
};

const bindingsMatch = (left: TVoiceJoinBinding, right: TVoiceJoinBinding) => {
	return left.channelId === right.channelId && left.sessionIncarnation === right.sessionIncarnation;
};

export type {
	TPreparedVoiceJoin,
	TVoiceJoinBinding,
	TVoiceJoinPresenceEvent,
	TVoiceJoinRequest,
	TVoiceJoinRequestContext,
	TVoiceJoinRuntime,
	TVoiceJoinServiceDependencies,
};
export { createVoiceJoinService, VoiceJoinSupersededError };
