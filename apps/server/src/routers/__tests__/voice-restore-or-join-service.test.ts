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
	public successfulCommits = 0;
	public successfulRollbacks = 0;
	private users = new Map<number, TVoiceUserState>();
	private sessionIncarnations = new Map<number, symbol>();
	private provisionalClaims = new Map<number, symbol>();

	constructor(id: number, order: string[]) {
		this.id = id;
		this.order = order;
	}

	public addUser(userId: number, state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>) {
		this.users.set(userId, { ...defaultVoiceState(), ...state });
		this.sessionIncarnations.set(userId, Symbol('voice-session-incarnation'));
	}

	public removeUser(userId: number) {
		this.users.delete(userId);
		this.sessionIncarnations.delete(userId);
		this.provisionalClaims.delete(userId);
	}

	public beginProvisionalRestoreSeat(userId: number) {
		const claim = Symbol('voice-provisional-restore-seat');
		this.provisionalClaims.set(userId, claim);
		return claim;
	}

	public hasUser(userId: number) {
		return this.users.has(userId);
	}

	public acquireRestoreSeat(
		userId: number,
		state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>,
		inheritedClaim?: symbol,
	) {
		this.order.push('seat:acquire');
		const existingState = this.users.get(userId);

		if (!existingState) {
			this.addUser(userId, state);
			return {
				added: true,
				claim: this.beginProvisionalRestoreSeat(userId),
			};
		}

		const previousState = { ...existingState };
		const claim =
			inheritedClaim && this.provisionalClaims.get(userId) === inheritedClaim
				? inheritedClaim
				: this.adoptProvisionalRestoreSeat(userId);
		this.users.set(userId, { ...existingState, ...state });

		return { added: false, claim, previousState };
	}

	public adoptProvisionalRestoreSeat(userId: number) {
		if (!this.provisionalClaims.has(userId)) {
			return undefined;
		}

		this.order.push('seat:adopt');
		return this.beginProvisionalRestoreSeat(userId);
	}

	public commitProvisionalRestoreSeat(userId: number, claim: symbol) {
		this.order.push('seat:commit-attempt');

		if (this.provisionalClaims.get(userId) !== claim) {
			return false;
		}

		this.provisionalClaims.delete(userId);
		this.successfulCommits += 1;
		this.order.push('seat:commit');
		return true;
	}

	public getUserState(userId: number) {
		return this.users.get(userId) ?? defaultVoiceState();
	}

	public getVoiceSessionIncarnation(userId: number) {
		return this.sessionIncarnations.get(userId);
	}

	public rollbackProvisionalRestoreSeat(userId: number, claim: symbol) {
		this.order.push('seat:rollback-attempt');

		if (this.provisionalClaims.get(userId) !== claim) {
			return false;
		}

		this.successfulRollbacks += 1;
		this.order.push('seat:rollback');
		this.removeUser(userId);
		return true;
	}
}

class FakeBootstrapCurrencyError extends Error {}

type TBootstrapResult = {
	attempt: number;
	channelUsers: number[];
};

type TServiceDependencies = TVoiceRestoreOrJoinServiceDependencies<FakeVoiceRestoreRuntime, TBootstrapResult>;
type TBootstrapOptions = Parameters<TServiceDependencies['createBootstrap']>[0];

type THarness = ReturnType<typeof createHarness>;

const createHarness = () => {
	const order: string[] = [];
	const events: TVoiceRestorePresenceEvent[] = [];
	const bindings: Array<{ channelId: number; sessionIncarnation: symbol }> = [];
	const pendingQueries: Array<{ userId: number; clientInstanceId?: string }> = [];
	const freshBootstrapStats = {
		commits: 0,
		disposals: 0,
		responses: 0,
	};
	const primaryRuntime = new FakeVoiceRestoreRuntime(PRIMARY_CHANNEL_ID, order);
	const secondaryRuntime = new FakeVoiceRestoreRuntime(SECONDARY_CHANNEL_ID, order);
	const runtimes = new Map<number, FakeVoiceRestoreRuntime>([
		[PRIMARY_CHANNEL_ID, primaryRuntime],
		[SECONDARY_CHANNEL_ID, secondaryRuntime],
	]);
	let bootstrapAttempt = 0;
	let freshBootstrapAttempt = 0;
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
		createProducer: (options: TBootstrapOptions, attempt: number) => Promise<void>;
		createConsumer: (options: TBootstrapOptions, attempt: number) => Promise<void>;
		beforeBootstrapReturn: (options: TBootstrapOptions, attempt: number) => Promise<void>;
		prepareProducer: (attempt: number) => Promise<void>;
		prepareConsumer: (attempt: number) => Promise<void>;
		beforeFreshPreparationReturn: (attempt: number) => Promise<void>;
		onFreshCommit: (attempt: number) => void;
		onFreshResponse: (attempt: number) => void;
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
		createProducer: async (options, attempt) => {
			order.push(`bootstrap:${attempt}:producer`);

			if (!options.isCurrent()) {
				throw new FakeBootstrapCurrencyError();
			}
		},
		createConsumer: async (options, attempt) => {
			order.push(`bootstrap:${attempt}:consumer`);

			if (!options.isCurrent()) {
				throw new FakeBootstrapCurrencyError();
			}
		},
		beforeBootstrapReturn: async (_options, attempt) => {
			order.push(`bootstrap:${attempt}:snapshot`);
		},
		prepareProducer: async (attempt) => {
			order.push(`fresh:${attempt}:producer`);
		},
		prepareConsumer: async (attempt) => {
			order.push(`fresh:${attempt}:consumer`);
		},
		beforeFreshPreparationReturn: async (attempt) => {
			order.push(`fresh:${attempt}:prepared`);
		},
		onFreshCommit: () => {},
		onFreshResponse: () => {},
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
		createBootstrap: async (options) => {
			bootstrapAttempt += 1;
			const attempt = bootstrapAttempt;
			order.push(`bootstrap:${attempt}:start`);
			await Promise.all([controls.createProducer(options, attempt), controls.createConsumer(options, attempt)]);
			await controls.beforeBootstrapReturn(options, attempt);

			return {
				attempt,
				channelUsers: options.runtime.hasUser(options.userId) ? [options.userId] : [],
			};
		},
		prepareFreshBootstrap: async (options) => {
			freshBootstrapAttempt += 1;
			const attempt = freshBootstrapAttempt;
			let state: 'prepared' | 'committed' | 'disposed' = 'prepared';
			order.push(`fresh:${attempt}:start`);
			await Promise.all([controls.prepareProducer(attempt), controls.prepareConsumer(attempt)]);
			await controls.beforeFreshPreparationReturn(attempt);

			return {
				commit: () => {
					if (state === 'committed') {
						return;
					}

					if (state === 'disposed') {
						throw new Error('Prepared fresh bootstrap is disposed');
					}

					state = 'committed';
					freshBootstrapStats.commits += 1;
					order.push(`fresh:${attempt}:commit`);
					controls.onFreshCommit(attempt);
				},
				dispose: () => {
					if (state !== 'prepared') {
						return;
					}

					state = 'disposed';
					freshBootstrapStats.disposals += 1;
					order.push(`fresh:${attempt}:dispose`);
				},
				buildCommittedResponse: () => {
					freshBootstrapStats.responses += 1;
					order.push(`fresh:${attempt}:response`);
					controls.onFreshResponse(attempt);
					return {
						attempt,
						channelUsers: options.runtime.hasUser(options.userId) ? [options.userId] : [],
					};
				},
			};
		},
		isBootstrapCurrencyError: (error) => error instanceof FakeBootstrapCurrencyError,
		logRestoreEvent: (event) => order.push(`log:${event}`),
		logJoined: () => order.push('log:joined'),
		logBootstrapRollback: () => order.push('log:rollback'),
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
		freshBootstrapStats,
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
		expect(harness.primaryRuntime.successfulCommits).toBe(0);
		expect(harness.freshBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.bindings).toHaveLength(1);
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
		expect(harness.order).toEqual([
			'target:resolve',
			'log:attempt',
			'fresh:1:start',
			'fresh:1:producer',
			'fresh:1:consumer',
			'fresh:1:prepared',
			'fresh:1:commit',
			'context:bind',
			'presence:join',
			'log:joined',
			'fresh:1:response',
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
		expect(harness.primaryRuntime.successfulCommits).toBe(0);

		harness.events.length = 0;
		await harness.service.restoreOrJoin(
			harness.request({ state: { micMuted: true, soundMuted: false }, reconnectAttemptId: 'state-unchanged' }),
		);

		expect(harness.events).toEqual([]);
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
		expect(harness.order).not.toContain('seat:acquire');
		expect(harness.order).not.toContain('bootstrap:1:start');
	});

	test('rejects an active session in another channel without mutating either runtime', async () => {
		const harness = createHarness();
		harness.secondaryRuntime.addUser(1, { micMuted: false, soundMuted: false });

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toMatchObject({
			reason: VOICE_SESSION_WRONG_CHANNEL,
		});
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.secondaryRuntime.hasUser(1)).toBe(true);
		expect(harness.order).not.toContain('seat:acquire');
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

	test('rolls back an inherited provisional claim before seat acquisition with exactly one leave', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		harness.primaryRuntime.beginProvisionalRestoreSeat(1);
		harness.setLabBehavior({ failMessage: 'forced failure' });

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toThrow('forced failure');

		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.primaryRuntime.successfulRollbacks).toBe(1);
		expect(harness.events.map((event) => event.type)).toEqual(['leave']);
		expect(harness.order).not.toContain('seat:acquire');
	});

	test('leaves no fresh-seat presence or membership when preparation fails', async () => {
		const harness = createHarness();
		const failure = new Error('producer failed');
		harness.controls.prepareProducer = async () => {
			throw failure;
		};

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toBe(failure);

		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.primaryRuntime.successfulRollbacks).toBe(0);
		expect(harness.events).toEqual([]);
		expect(harness.bindings).toEqual([]);
		expect(harness.freshBootstrapStats).toEqual({ commits: 0, disposals: 0, responses: 0 });
		expect(harness.order).not.toContain('log:rollback');
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
		expect(harness.order).not.toContain('seat:acquire');
	});

	test('treats an abort triggered by commit as post-commit ownership', async () => {
		const harness = createHarness();
		const abortController = new AbortController();
		harness.controls.onFreshCommit = () => abortController.abort();

		await expect(harness.service.restoreOrJoin(harness.request({ signal: abortController.signal }))).resolves.toEqual({
			attempt: 1,
			channelUsers: [1],
		});
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.freshBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
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
		expect(harness.freshBootstrapStats).toEqual({ commits: 0, disposals: 0, responses: 0 });
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('allocates nothing for a fresh reconnect-lab failure', async () => {
		const harness = createHarness();
		harness.setLabBehavior({ failMessage: 'forced failure' });

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toThrow('forced failure');
		expect(harness.freshBootstrapStats).toEqual({ commits: 0, disposals: 0, responses: 0 });
		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('disposes a prepared pair when a same-client manual join creates the seat before commit', async () => {
		const harness = createHarness();
		const preparationEntered = createDeferred();
		const preparationRelease = createDeferred();
		harness.controls.beforeFreshPreparationReturn = async () => {
			preparationEntered.resolve();
			await preparationRelease.promise;
		};
		const restore = harness.service.restoreOrJoin(harness.request());
		await preparationEntered.promise;
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: true });
		preparationRelease.resolve();

		await expectRejectedWith(restore, VoiceRestoreAttemptSupersededServiceError);
		expect(harness.primaryRuntime.getUserState(1)).toMatchObject({ micMuted: false, soundMuted: true });
		expect(harness.freshBootstrapStats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('disposes a prepared pair when another client creates the requested-channel seat before commit', async () => {
		const harness = createHarness();
		const preparationEntered = createDeferred();
		const preparationRelease = createDeferred();
		harness.controls.beforeFreshPreparationReturn = async () => {
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
		expect(harness.freshBootstrapStats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.bindings).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	test('keeps a committed fresh session when response construction fails', async () => {
		const harness = createHarness();
		const failure = new Error('Response construction failed');
		harness.controls.onFreshResponse = () => {
			throw failure;
		};

		await expect(harness.service.restoreOrJoin(harness.request())).rejects.toBe(failure);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.freshBootstrapStats).toEqual({ commits: 1, disposals: 0, responses: 1 });
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
			harness.controls.beforeFreshPreparationReturn = async (attempt) => {
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
			expect(harness.primaryRuntime.successfulCommits).toBe(0);
			expect(harness.primaryRuntime.successfulRollbacks).toBe(0);
			expect(harness.freshBootstrapStats.commits).toBe(1);
			expect(harness.freshBootstrapStats.disposals).toBe(barrier.expectedPreparedDisposals);
			expect(harness.freshBootstrapStats.responses).toBe(1);
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

	test('does not let an aborted attempt roll back a claim adopted and committed by its successor', async () => {
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
		expect(harness.primaryRuntime.successfulCommits).toBe(0);
		expect(harness.primaryRuntime.successfulRollbacks).toBe(0);
		expect(harness.freshBootstrapStats.commits).toBe(1);
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
			expect(harness.freshBootstrapStats.commits).toBe(0);
			expect(harness.bindings).toEqual([]);
			expect(harness.primaryRuntime.hasUser(1)).toBe(false);
			expect(harness.primaryRuntime.successfulRollbacks).toBe(0);
			expect(harness.events).toEqual([]);
			expect(harness.freshBootstrapStats.disposals).toBe(barrier.expectedPreparedDisposals);
			expect(harness.freshBootstrapStats.responses).toBe(0);
		});
	}
});
