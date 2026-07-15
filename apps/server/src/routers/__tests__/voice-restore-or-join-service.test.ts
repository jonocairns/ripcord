import { describe, expect, test } from 'bun:test';
import type { TVoiceUserState } from '@sharkord/shared';
import {
	createVoiceRestoreOrJoinService,
	type TVoiceReconnectLabRestoreBehavior,
	type TVoiceRestoreConnection,
	type TVoiceRestoreOrJoinRequest,
	type TVoiceRestoreOrJoinServiceDependencies,
	type TVoiceRestorePresenceEvent,
	type TVoiceRestoreRuntime,
	VOICE_SESSION_OWNED_ELSEWHERE,
	VOICE_SESSION_WRONG_CHANNEL,
	VoiceRestoreAttemptCancelledError,
	VoiceRestoreAttemptSupersededServiceError,
	VoiceRestoreConflictError,
} from '../voice/restore-or-join-service';

const PRIMARY_CHANNEL_ID = 2;
const SECONDARY_CHANNEL_ID = 3;

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

const createDeferred = <T = void>(): TDeferred<T> => {
	let resolvePromise: (value: T) => void = () => {};
	let rejectPromise: (error: unknown) => void = () => {};
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});

	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
};

const defaultVoiceState = (): TVoiceUserState => ({
	micMuted: false,
	soundMuted: false,
	webcamEnabled: false,
	sharingScreen: false,
});

class FakeVoiceRestoreRuntime implements TVoiceRestoreRuntime {
	public readonly id: number;
	public readonly order: string[];
	private users = new Map<number, TVoiceUserState>();
	private sessionIncarnations = new Map<number, symbol>();
	private sessionMutationTokens = new Map<number, symbol>();

	constructor(id: number, order: string[]) {
		this.id = id;
		this.order = order;
	}

	public addUser(userId: number, state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>) {
		this.users.set(userId, { ...defaultVoiceState(), ...state });
		this.sessionIncarnations.set(userId, Symbol('voice-session-incarnation'));
		this.sessionMutationTokens.set(userId, Symbol('voice-session-mutation'));
	}

	public removeUser(userId: number) {
		this.users.delete(userId);
		this.sessionIncarnations.delete(userId);
		this.sessionMutationTokens.delete(userId);
	}

	public hasUser(userId: number) {
		return this.users.has(userId);
	}

	public reconcileVoiceRestoreState(userId: number, state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>) {
		this.order.push('seat:reconcile');
		const existingState = this.users.get(userId);

		if (!existingState) {
			return undefined;
		}

		const previousState = { ...existingState };
		this.users.set(userId, { ...existingState, ...state });
		const sessionIdentity = this.getVoiceSessionIdentity(userId);

		if (!sessionIdentity) {
			return undefined;
		}

		return {
			previousState,
			currentState: this.getUserState(userId),
			sessionIdentity,
		};
	}

	public getUserState(userId: number) {
		return this.users.get(userId) ?? defaultVoiceState();
	}

	public getVoiceSessionIdentity(userId: number) {
		const incarnation = this.sessionIncarnations.get(userId);
		const mutationToken = this.sessionMutationTokens.get(userId);

		return incarnation && mutationToken ? { incarnation, mutationToken } : undefined;
	}

	public getVoiceSessionIncarnation(userId: number) {
		return this.sessionIncarnations.get(userId);
	}

	public isVoiceSessionIdentityCurrent(userId: number, identity: { incarnation: symbol; mutationToken: symbol }) {
		return (
			this.sessionIncarnations.get(userId) === identity.incarnation &&
			this.sessionMutationTokens.get(userId) === identity.mutationToken &&
			this.users.has(userId)
		);
	}
}

type TBootstrapResult = {
	attempt: number;
	channelUsers: number[];
};

type TServiceDependencies = TVoiceRestoreOrJoinServiceDependencies<FakeVoiceRestoreRuntime, TBootstrapResult>;

type THarness = ReturnType<typeof createHarness>;

const createHarness = () => {
	const order: string[] = [];
	const events: TVoiceRestorePresenceEvent[] = [];
	const bindings: Array<{ channelId: number; sessionIncarnation: symbol }> = [];
	const pendingQueries: Array<{ userId: number; clientInstanceId?: string }> = [];
	const preparedBootstrapStats = {
		commits: 0,
		disposals: 0,
		responses: 0,
	};
	const observations: {
		pairs: unknown[];
		finishes: unknown[];
	} = { pairs: [], finishes: [] };
	const primaryRuntime = new FakeVoiceRestoreRuntime(PRIMARY_CHANNEL_ID, order);
	const secondaryRuntime = new FakeVoiceRestoreRuntime(SECONDARY_CHANNEL_ID, order);
	const runtimes = new Map<number, FakeVoiceRestoreRuntime>([
		[PRIMARY_CHANNEL_ID, primaryRuntime],
		[SECONDARY_CHANNEL_ID, secondaryRuntime],
	]);
	let preparedBootstrapAttempt = 0;
	let labBehavior: TVoiceReconnectLabRestoreBehavior | undefined;
	let pendingChannelIds: number[] = [];
	let ownConnection: TVoiceRestoreConnection | undefined = {
		identity: {},
		clientInstanceId: 'client-a',
	};
	let userConnections: TVoiceRestoreConnection[] = [];
	const controls: {
		resolveTarget: (
			channelId: number,
		) => Promise<{ channel: { id: number; name: string }; runtime: FakeVoiceRestoreRuntime }>;
		delay: (milliseconds: number) => Promise<void>;
		prepareProducer: (attempt: number) => Promise<void>;
		prepareConsumer: (attempt: number) => Promise<void>;
		beforePreparationReturn: (attempt: number) => Promise<void>;
		onCommit: (attempt: number) => void;
		onResponse: (attempt: number) => void;
	} = {
		resolveTarget: async (channelId) => {
			order.push('target:resolve');
			const runtime = runtimes.get(channelId);

			if (!runtime) {
				throw new Error('Runtime not found');
			}

			return { channel: { id: channelId, name: `Voice ${channelId}` }, runtime };
		},
		delay: async () => {},
		prepareProducer: async (attempt) => {
			order.push(`prepared:${attempt}:producer`);
		},
		prepareConsumer: async (attempt) => {
			order.push(`prepared:${attempt}:consumer`);
		},
		beforePreparationReturn: async (attempt) => {
			order.push(`prepared:${attempt}:ready`);
		},
		onCommit: () => {},
		onResponse: () => {},
	};

	const dependencies: TServiceDependencies = {
		findRuntimeByChannelId: (channelId) => runtimes.get(channelId),
		findRuntimeByUserId: (userId) => Array.from(runtimes.values()).find((runtime) => runtime.hasUser(userId)),
		getPendingVoiceChannelIdsOwnedElsewhere: (userId, clientInstanceId) => {
			pendingQueries.push({ userId, clientInstanceId });
			return pendingChannelIds;
		},
		consumeReconnectLabBehavior: () => {
			const behavior = labBehavior;
			labBehavior = undefined;
			return behavior;
		},
		delay: (milliseconds) => controls.delay(milliseconds),
		prepareBootstrap: async (options) => {
			preparedBootstrapAttempt += 1;
			const attempt = preparedBootstrapAttempt;
			let state: 'prepared' | 'committed' | 'disposed' = 'prepared';
			order.push(`prepared:${attempt}:start`);
			await Promise.all([controls.prepareProducer(attempt), controls.prepareConsumer(attempt)]);
			await controls.beforePreparationReturn(attempt);
			options.pairObserver?.({ outcome: 'prepared' });

			return {
				assertCommittable: () => {
					if (state === 'disposed') {
						throw new Error('Prepared fresh bootstrap is disposed');
					}
				},
				commit: () => {
					if (state === 'committed') {
						return;
					}

					if (state === 'disposed') {
						throw new Error('Prepared fresh bootstrap is disposed');
					}

					state = 'committed';
					options.pairObserver?.({ outcome: 'committed' });
					preparedBootstrapStats.commits += 1;
					order.push(`prepared:${attempt}:commit`);
					controls.onCommit(attempt);
				},
				dispose: () => {
					if (state !== 'prepared') {
						return;
					}

					state = 'disposed';
					options.pairObserver?.({ outcome: 'disposed', cause: 'request_cleanup' });
					preparedBootstrapStats.disposals += 1;
					order.push(`prepared:${attempt}:dispose`);
				},
				buildCommittedResponse: () => {
					preparedBootstrapStats.responses += 1;
					order.push(`prepared:${attempt}:response`);
					controls.onResponse(attempt);
					return {
						attempt,
						channelUsers: options.runtime.hasUser(options.userId) ? [options.userId] : [],
					};
				},
			};
		},
		observer: {
			startAttempt: () => ({
				pairObserver: (event) => observations.pairs.push(event),
				finish: (result) => observations.finishes.push(result),
			}),
		},
		logRestoreEvent: (event) => order.push(`log:${event}`),
		logJoined: () => order.push('log:joined'),
	};
	const service = createVoiceRestoreOrJoinService(dependencies);

	const request = (
		overrides: Partial<{
			channelId: number;
			clientInstanceId: string | undefined;
			reconnectAttemptId: string;
			signal: AbortSignal;
			state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>;
		}> = {},
	): TVoiceRestoreOrJoinRequest<FakeVoiceRestoreRuntime> => ({
		channelId: overrides.channelId ?? PRIMARY_CHANNEL_ID,
		state: overrides.state ?? { micMuted: false, soundMuted: false },
		reconnectAttemptId: overrides.reconnectAttemptId ?? 'attempt-1',
		user: { id: 1, name: 'Test user' },
		signal: overrides.signal,
		context: {
			resolveTarget: (channelId) => controls.resolveTarget(channelId),
			getClientInstanceId: () => overrides.clientInstanceId ?? ownConnection?.clientInstanceId,
			getOwnConnection: () => ownConnection,
			getUserConnections: () => userConnections,
			closeOwnConnection: (code, reason) => order.push(`connection:close:${code}:${reason}`),
			bindVoiceSession: (channelId, sessionIncarnation) => {
				order.push('context:bind');
				bindings.push({ channelId, sessionIncarnation });
			},
			publishPresence: (event) => {
				order.push(`presence:${event.type}`);
				events.push(event);
			},
		},
	});

	return {
		service,
		request,
		controls,
		order,
		events,
		bindings,
		pendingQueries,
		preparedBootstrapStats,
		observations,
		primaryRuntime,
		secondaryRuntime,
		setLabBehavior: (behavior: TVoiceReconnectLabRestoreBehavior | undefined) => {
			labBehavior = behavior;
		},
		setPendingChannelIds: (channelIds: number[]) => {
			pendingChannelIds = channelIds;
		},
		setOwnConnection: (connection: TVoiceRestoreConnection | undefined) => {
			ownConnection = connection;
		},
		setUserConnections: (connections: TVoiceRestoreConnection[]) => {
			userConnections = connections;
		},
	};
};

const expectRejectedWith = async <TError>(promise: Promise<unknown>, errorType: new () => TError) => {
	const outcome = await promise.then(
		() => ({ resolved: true as const, error: undefined }),
		(error: unknown) => ({ resolved: false as const, error }),
	);

	expect(outcome.resolved).toBe(false);
	expect(outcome.error).toBeInstanceOf(errorType);
};

describe('voice restore-or-join service', () => {
	test('prepares privately before committing fresh transport, membership, binding, presence, and response', async () => {
		const harness = createHarness();

		const result = await harness.service.restoreOrJoin(harness.request());

		expect(result).toEqual({ attempt: 1, channelUsers: [1] });
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
		expect(harness.observations).toEqual({
			pairs: [{ outcome: 'prepared' }, { outcome: 'committed' }],
			finishes: [{ path: 'fresh', outcome: 'succeeded' }],
		});
		expect(harness.order).toEqual([
			'target:resolve',
			'log:attempt',
			'prepared:1:start',
			'prepared:1:producer',
			'prepared:1:consumer',
			'prepared:1:ready',
			'prepared:1:commit',
			'context:bind',
			'presence:join',
			'log:joined',
			'prepared:1:response',
			'log:outcome',
		]);
	});

	test('preserves an existing seat and publishes only a required state update', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });

		await harness.service.restoreOrJoin(
			harness.request({ state: { micMuted: true, soundMuted: false }, reconnectAttemptId: 'state-change' }),
		);

		expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: true, soundMuted: false });
		expect(harness.events.map((event) => event.type)).toEqual(['state-update']);

		harness.events.length = 0;
		await harness.service.restoreOrJoin(
			harness.request({ state: { micMuted: true, soundMuted: false }, reconnectAttemptId: 'state-unchanged' }),
		);

		expect(harness.events).toEqual([]);
	});

	test('prepares privately before atomically committing an existing-session pair and binding', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const sessionIncarnation = harness.primaryRuntime.getVoiceSessionIncarnation(1);
		if (sessionIncarnation === undefined) {
			throw new Error('Expected the existing seat to have an incarnation');
		}
		harness.controls.beforePreparationReturn = async (attempt) => {
			expect(attempt).toBe(1);
			expect(harness.primaryRuntime.getVoiceSessionIncarnation(1)).toBe(sessionIncarnation);
			expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: true, soundMuted: false });
			expect(harness.preparedBootstrapStats.commits).toBe(0);
			expect(harness.bindings).toEqual([]);
			harness.order.push(`prepared:${attempt}:ready`);
		};

		const result = await harness.service.restoreOrJoin(
			harness.request({ state: { micMuted: true, soundMuted: false } }),
		);

		expect(result).toEqual({ attempt: 1, channelUsers: [1] });
		expect(harness.primaryRuntime.getVoiceSessionIncarnation(1)).toBe(sessionIncarnation);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toEqual([{ channelId: PRIMARY_CHANNEL_ID, sessionIncarnation }]);
		expect(harness.events.map((event) => event.type)).toEqual(['state-update']);
		expect(harness.order).toEqual([
			'target:resolve',
			'log:attempt',
			'seat:reconcile',
			'presence:state-update',
			'prepared:1:start',
			'prepared:1:producer',
			'prepared:1:consumer',
			'prepared:1:ready',
			'prepared:1:commit',
			'context:bind',
			'prepared:1:response',
			'log:outcome',
		]);
	});

	test('disposes an existing-session pair and preserves the seat when aborted before commit', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const sessionIncarnation = harness.primaryRuntime.getVoiceSessionIncarnation(1);
		const preparationEntered = createDeferred();
		const preparationRelease = createDeferred();
		harness.controls.beforePreparationReturn = async () => {
			preparationEntered.resolve();
			await preparationRelease.promise;
		};
		const abortController = new AbortController();
		const restore = harness.service.restoreOrJoin(
			harness.request({
				state: { micMuted: true, soundMuted: false },
				signal: abortController.signal,
			}),
		);

		await preparationEntered.promise;
		abortController.abort();
		preparationRelease.resolve();

		await expectRejectedWith(restore, VoiceRestoreAttemptCancelledError);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.primaryRuntime.getVoiceSessionIncarnation(1)).toBe(sessionIncarnation);
		expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: true, soundMuted: false });
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.bindings).toEqual([]);
		expect(harness.events.map((event) => event.type)).toEqual(['state-update']);
		expect(harness.observations).toEqual({
			pairs: [{ outcome: 'prepared' }, { outcome: 'disposed', cause: 'request_cleanup' }],
			finishes: [{ path: 'existing', outcome: 'cancelled', error: expect.any(VoiceRestoreAttemptCancelledError) }],
		});
	});

	test('lets only the newest overlapping existing-session preparation commit', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const stalePreparationEntered = createDeferred();
		const stalePreparationRelease = createDeferred();
		harness.controls.beforePreparationReturn = async (attempt) => {
			if (attempt === 1) {
				stalePreparationEntered.resolve();
				await stalePreparationRelease.promise;
			}
		};
		const staleRestore = harness.service.restoreOrJoin(harness.request({ reconnectAttemptId: 'stale-existing' }));
		await stalePreparationEntered.promise;

		const currentRestore = await harness.service.restoreOrJoin(
			harness.request({ reconnectAttemptId: 'current-existing' }),
		);
		stalePreparationRelease.resolve();

		expect(currentRestore).toEqual({ attempt: 2, channelUsers: [1] });
		await expectRejectedWith(staleRestore, VoiceRestoreAttemptSupersededServiceError);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 1, responses: 1 });
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events).toEqual([]);
	});

	test('does not dispose or roll back an existing pair when commit triggers abort', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const abortController = new AbortController();
		harness.controls.onCommit = () => abortController.abort();

		await expect(harness.service.restoreOrJoin(harness.request({ signal: abortController.signal }))).resolves.toEqual({
			attempt: 1,
			channelUsers: [1],
		});
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events).toEqual([]);
	});

	test('keeps a committed existing pair when response construction fails', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const failure = new Error('Existing response construction failed');
		harness.controls.onResponse = () => {
			throw failure;
		};

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toBe(failure);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events).toEqual([]);
		expect(harness.observations).toEqual({
			pairs: [{ outcome: 'prepared' }, { outcome: 'committed' }],
			finishes: [{ path: 'existing', outcome: 'postcommit_response_failed', error: failure }],
		});
	});

	test('disposes an existing pair when the seat incarnation changes before commit', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const originalIncarnation = harness.primaryRuntime.getVoiceSessionIncarnation(1);
		const preparationEntered = createDeferred();
		const preparationRelease = createDeferred();
		harness.controls.beforePreparationReturn = async () => {
			preparationEntered.resolve();
			await preparationRelease.promise;
		};
		const restore = harness.service.restoreOrJoin(harness.request());
		await preparationEntered.promise;

		harness.primaryRuntime.removeUser(1);
		harness.primaryRuntime.addUser(1, { micMuted: true, soundMuted: true });
		preparationRelease.resolve();

		await expectRejectedWith(restore, VoiceRestoreAttemptSupersededServiceError);
		expect(harness.primaryRuntime.getVoiceSessionIncarnation(1)).not.toBe(originalIncarnation);
		expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: true, soundMuted: true });
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.bindings).toEqual([]);
	});

	test('rejects another client that owns the requested channel without acquiring or mutating its seat', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		harness.setUserConnections([
			{ identity: {}, clientInstanceId: 'client-b', currentVoiceChannelId: PRIMARY_CHANNEL_ID },
		]);

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toMatchObject({
			reason: VOICE_SESSION_OWNED_ELSEWHERE,
		});
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.order).not.toContain('seat:reconcile');
		expect(harness.order).not.toContain('prepared:1:start');
	});

	test('rejects an active session in another channel without mutating either runtime', async () => {
		const harness = createHarness();
		harness.secondaryRuntime.addUser(1, { micMuted: false, soundMuted: false });

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toMatchObject({
			reason: VOICE_SESSION_WRONG_CHANNEL,
		});
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.secondaryRuntime.hasUser(1)).toBe(true);
		expect(harness.order).not.toContain('seat:reconcile');
	});

	test('excludes same-client sockets and passes client ownership to pending-grace conflict resolution', async () => {
		const sameClientHarness = createHarness();
		sameClientHarness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		sameClientHarness.setUserConnections([
			{ identity: {}, clientInstanceId: 'client-a', currentVoiceChannelId: PRIMARY_CHANNEL_ID },
		]);

		await expect(sameClientHarness.service.restoreOrJoin(sameClientHarness.request())).resolves.toMatchObject({
			channelUsers: [1],
		});
		expect(sameClientHarness.pendingQueries).toEqual([{ userId: 1, clientInstanceId: 'client-a' }]);

		const pendingConflictHarness = createHarness();
		pendingConflictHarness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		pendingConflictHarness.setPendingChannelIds([PRIMARY_CHANNEL_ID]);

		await expect(pendingConflictHarness.service.restoreOrJoin(pendingConflictHarness.request())).rejects.toMatchObject({
			reason: VOICE_SESSION_OWNED_ELSEWHERE,
		});
		expect(pendingConflictHarness.primaryRuntime.hasUser(1)).toBe(true);
	});

	test('leaves no fresh-seat presence or membership when preparation fails', async () => {
		const harness = createHarness();
		const failure = new Error('producer failed');
		harness.controls.prepareProducer = async () => {
			throw failure;
		};

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toBe(failure);

		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.events).toEqual([]);
		expect(harness.bindings).toEqual([]);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 0, responses: 0 });
	});

	test('lets a manual join during an await win without recreating the old seat', async () => {
		const harness = createHarness();
		const delayBarrier = createDeferred();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		harness.setLabBehavior({ delayMs: 1 });
		harness.controls.delay = () => delayBarrier.promise;

		const restore = harness.service.restoreOrJoin(harness.request());
		await Promise.resolve();
		harness.primaryRuntime.removeUser(1);
		harness.secondaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		delayBarrier.resolve();

		await expect(restore).rejects.toMatchObject({ reason: VOICE_SESSION_WRONG_CHANNEL });
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.secondaryRuntime.hasUser(1)).toBe(true);
		expect(harness.order).not.toContain('seat:reconcile');
	});

	test('treats an abort triggered by commit as post-commit ownership', async () => {
		const harness = createHarness();
		const abortController = new AbortController();
		harness.controls.onCommit = () => abortController.abort();

		await expect(harness.service.restoreOrJoin(harness.request({ signal: abortController.signal }))).resolves.toEqual({
			attempt: 1,
			channelUsers: [1],
		});
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
	});

	test('allocates nothing when target resolution fails', async () => {
		const harness = createHarness();
		const failure = new Error('Target resolution failed');
		harness.controls.resolveTarget = async () => {
			throw failure;
		};

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toBe(failure);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 0, responses: 0 });
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('allocates nothing for a fresh reconnect-lab failure', async () => {
		const harness = createHarness();
		harness.setLabBehavior({ failMessage: 'forced failure' });

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toThrow('forced failure');
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 0, responses: 0 });
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('disposes a prepared pair when a same-client manual join creates the seat before commit', async () => {
		const harness = createHarness();
		const preparationEntered = createDeferred();
		const preparationRelease = createDeferred();
		harness.controls.beforePreparationReturn = async () => {
			preparationEntered.resolve();
			await preparationRelease.promise;
		};
		const restore = harness.service.restoreOrJoin(harness.request());
		await preparationEntered.promise;
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: true });
		preparationRelease.resolve();

		await expectRejectedWith(restore, VoiceRestoreAttemptSupersededServiceError);
		expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: false, soundMuted: true });
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('disposes a prepared pair when another client creates the requested-channel seat before commit', async () => {
		const harness = createHarness();
		const preparationEntered = createDeferred();
		const preparationRelease = createDeferred();
		harness.controls.beforePreparationReturn = async () => {
			preparationEntered.resolve();
			await preparationRelease.promise;
		};
		const restore = harness.service.restoreOrJoin(harness.request());
		await preparationEntered.promise;
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: true });
		harness.setUserConnections([
			{ identity: {}, clientInstanceId: 'client-b', currentVoiceChannelId: PRIMARY_CHANNEL_ID },
		]);
		preparationRelease.resolve();

		await expect(restore).rejects.toMatchObject({ reason: VOICE_SESSION_OWNED_ELSEWHERE });
		expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: false, soundMuted: true });
		expect(harness.preparedBootstrapStats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('keeps a committed fresh session when response construction fails', async () => {
		const harness = createHarness();
		const failure = new Error('Response construction failed');
		harness.controls.onResponse = () => {
			throw failure;
		};

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toBe(failure);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.preparedBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
	});
});

type TSupersessionBarrier = {
	name: string;
	expectedPreparedDisposals: number;
	install: (harness: THarness) => {
		entered: Promise<void>;
		release: () => void;
	};
};

const supersessionBarriers: TSupersessionBarrier[] = [
	{
		name: 'before target resolution',
		expectedPreparedDisposals: 0,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			const originalResolveTarget = harness.controls.resolveTarget;
			let callCount = 0;
			harness.controls.resolveTarget = async (channelId) => {
				callCount += 1;

				if (callCount === 1) {
					entered.resolve();
					await release.promise;
				}

				return originalResolveTarget(channelId);
			};

			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'before seat acquisition',
		expectedPreparedDisposals: 0,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			harness.setLabBehavior({ delayMs: 1 });
			harness.controls.delay = async () => {
				entered.resolve();
				await release.promise;
			};

			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'during producer preparation',
		expectedPreparedDisposals: 1,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			const originalPrepareProducer = harness.controls.prepareProducer;
			harness.controls.prepareProducer = async (attempt) => {
				if (attempt === 1) {
					entered.resolve();
					await release.promise;
				}

				await originalPrepareProducer(attempt);
			};

			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'during consumer preparation',
		expectedPreparedDisposals: 1,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			const originalPrepareConsumer = harness.controls.prepareConsumer;
			harness.controls.prepareConsumer = async (attempt) => {
				if (attempt === 1) {
					entered.resolve();
					await release.promise;
				}

				await originalPrepareConsumer(attempt);
			};

			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'after preparation before commit',
		expectedPreparedDisposals: 1,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			harness.controls.beforePreparationReturn = async (attempt) => {
				if (attempt === 1) {
					entered.resolve();
					await release.promise;
				}
			};

			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
];

describe('voice restore attempt supersession', () => {
	for (const barrier of supersessionBarriers) {
		test(`supersedes a predecessor ${barrier.name}`, async () => {
			const harness = createHarness();
			const control = barrier.install(harness);
			const staleRestore = harness.service.restoreOrJoin(
				harness.request({ reconnectAttemptId: `stale-${barrier.name}` }),
			);
			await control.entered;

			const currentRestore = await harness.service.restoreOrJoin(
				harness.request({ reconnectAttemptId: `current-${barrier.name}` }),
			);
			control.release();

			expect(currentRestore.channelUsers).toEqual([1]);
			await expectRejectedWith(staleRestore, VoiceRestoreAttemptSupersededServiceError);
			expect(harness.primaryRuntime.hasUser(1)).toBe(true);
			expect(harness.preparedBootstrapStats.commits).toBe(1);
			expect(harness.preparedBootstrapStats.disposals).toBe(barrier.expectedPreparedDisposals);
			expect(harness.preparedBootstrapStats.responses).toBe(1);
			expect(harness.bindings).toHaveLength(1);
			expect(harness.events.map((event) => event.type)).toEqual(['join']);
		});
	}

	test('keeps cancellation as the first cause when abort precedes a successor', async () => {
		const harness = createHarness();
		const targetEntered = createDeferred();
		const targetRelease = createDeferred();
		const originalResolveTarget = harness.controls.resolveTarget;
		let callCount = 0;
		harness.controls.resolveTarget = async (channelId) => {
			callCount += 1;

			if (callCount === 1) {
				targetEntered.resolve();
				await targetRelease.promise;
			}

			return originalResolveTarget(channelId);
		};
		const abortController = new AbortController();
		const cancelledRestore = harness.service.restoreOrJoin(harness.request({ signal: abortController.signal }));
		await targetEntered.promise;
		abortController.abort();
		await harness.service.restoreOrJoin(harness.request({ reconnectAttemptId: 'successor' }));
		targetRelease.resolve();

		await expectRejectedWith(cancelledRestore, VoiceRestoreAttemptCancelledError);
	});

	test('keeps supersession as the first cause when a successor precedes abort', async () => {
		const harness = createHarness();
		const targetEntered = createDeferred();
		const targetRelease = createDeferred();
		const originalResolveTarget = harness.controls.resolveTarget;
		let callCount = 0;
		harness.controls.resolveTarget = async (channelId) => {
			callCount += 1;

			if (callCount === 1) {
				targetEntered.resolve();
				await targetRelease.promise;
			}

			return originalResolveTarget(channelId);
		};
		const abortController = new AbortController();
		const supersededRestore = harness.service.restoreOrJoin(harness.request({ signal: abortController.signal }));
		await targetEntered.promise;
		await harness.service.restoreOrJoin(harness.request({ reconnectAttemptId: 'successor' }));
		abortController.abort();
		targetRelease.resolve();

		await expectRejectedWith(supersededRestore, VoiceRestoreAttemptSupersededServiceError);
	});

	test('does not let an aborted preparation affect its committed successor', async () => {
		const harness = createHarness();
		const producerEntered = createDeferred();
		const producerRelease = createDeferred();
		const originalPrepareProducer = harness.controls.prepareProducer;
		harness.controls.prepareProducer = async (attempt) => {
			if (attempt === 1) {
				producerEntered.resolve();
				await producerRelease.promise;
			}

			await originalPrepareProducer(attempt);
		};
		const abortController = new AbortController();
		const cancelledRestore = harness.service.restoreOrJoin(harness.request({ signal: abortController.signal }));
		await producerEntered.promise;
		abortController.abort();

		const successor = await harness.service.restoreOrJoin(harness.request({ reconnectAttemptId: 'successor' }));
		producerRelease.resolve();

		expect(successor.channelUsers).toEqual([1]);
		await expectRejectedWith(cancelledRestore, VoiceRestoreAttemptCancelledError);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.preparedBootstrapStats.commits).toBe(1);
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
		expect(harness.bindings).toHaveLength(1);
	});

	test('does not accidentally supersede a different client-instance owner', async () => {
		const harness = createHarness();
		const targetEntered = createDeferred();
		const targetRelease = createDeferred();
		const originalResolveTarget = harness.controls.resolveTarget;
		let callCount = 0;
		harness.controls.resolveTarget = async (channelId) => {
			callCount += 1;

			if (callCount === 1) {
				targetEntered.resolve();
				await targetRelease.promise;
			}

			return originalResolveTarget(channelId);
		};
		const firstRestore = harness.service.restoreOrJoin(harness.request({ clientInstanceId: 'client-a' }));
		await targetEntered.promise;

		harness.setPendingChannelIds([PRIMARY_CHANNEL_ID]);
		await expect(
			harness.service.restoreOrJoin(
				harness.request({ clientInstanceId: 'client-b', reconnectAttemptId: 'different-owner' }),
			),
		).rejects.toBeInstanceOf(VoiceRestoreConflictError);
		harness.setPendingChannelIds([]);
		targetRelease.resolve();

		await expect(firstRestore).resolves.toMatchObject({ channelUsers: [1] });
	});
});

describe('voice restore attempt cancellation', () => {
	for (const barrier of supersessionBarriers) {
		test(`distinguishes abort ${barrier.name}`, async () => {
			const harness = createHarness();
			const control = barrier.install(harness);
			const abortController = new AbortController();
			const restore = harness.service.restoreOrJoin(
				harness.request({ reconnectAttemptId: `abort-${barrier.name}`, signal: abortController.signal }),
			);
			await control.entered;
			abortController.abort();
			control.release();

			await expectRejectedWith(restore, VoiceRestoreAttemptCancelledError);
			expect(harness.preparedBootstrapStats.commits).toBe(0);
			expect(harness.bindings).toEqual([]);
			expect(harness.primaryRuntime.hasUser(1)).toBe(false);
			expect(harness.events).toEqual([]);
			expect(harness.preparedBootstrapStats.disposals).toBe(barrier.expectedPreparedDisposals);
			expect(harness.preparedBootstrapStats.responses).toBe(0);
		});
	}
});
