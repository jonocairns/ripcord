import { describe, expect, test } from 'bun:test';
import type { TVoiceUserState } from '@sharkord/shared';
import {
	createVoiceJoinService,
	type TVoiceJoinBinding,
	type TVoiceJoinPresenceEvent,
	type TVoiceJoinRuntime,
	VoiceJoinSupersededError,
} from '../voice/join-service';
import {
	createVoiceSessionAttemptRegistry,
	getVoiceSessionAttemptOwner,
	VoiceSessionAttemptCancelledError,
	VoiceSessionAttemptSupersededError,
} from '../voice/session-attempt-registry';

const PRIMARY_CHANNEL_ID = 2;
const SECONDARY_CHANNEL_ID = 3;

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

const createDeferred = <T = void>(): TDeferred<T> => {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});

	return { promise, resolve: resolvePromise };
};

const defaultState = (): TVoiceUserState => ({
	micMuted: false,
	soundMuted: false,
	webcamEnabled: false,
	sharingScreen: false,
});

class FakeJoinRuntime implements TVoiceJoinRuntime {
	public readonly id: number;
	private users = new Map<number, TVoiceUserState>();
	private incarnations = new Map<number, symbol>();
	private mutationTokens = new Map<number, symbol>();

	constructor(id: number) {
		this.id = id;
	}

	public addUser(userId: number, state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>) {
		if (this.users.has(userId)) {
			return;
		}

		this.users.set(userId, { ...defaultState(), ...state });
		this.incarnations.set(userId, Symbol('incarnation'));
		this.mutationTokens.set(userId, Symbol('mutation'));
	}

	public getUserState(userId: number) {
		return this.users.get(userId) ?? defaultState();
	}

	public getVoiceSessionIdentity(userId: number) {
		const incarnation = this.incarnations.get(userId);
		const mutationToken = this.mutationTokens.get(userId);

		return incarnation && mutationToken ? { incarnation, mutationToken } : undefined;
	}

	public isVoiceSessionIdentityCurrent(userId: number, identity: { incarnation: symbol; mutationToken: symbol }) {
		return (
			this.incarnations.get(userId) === identity.incarnation &&
			this.mutationTokens.get(userId) === identity.mutationToken &&
			this.users.has(userId)
		);
	}

	public removeUserIfSessionMatches(userId: number, sessionIncarnation: symbol | undefined) {
		if (sessionIncarnation === undefined || this.incarnations.get(userId) !== sessionIncarnation) {
			return false;
		}

		this.users.delete(userId);
		this.incarnations.delete(userId);
		this.mutationTokens.delete(userId);
		return true;
	}

	public rotateTransportIdentity(userId: number) {
		if (this.users.has(userId)) {
			this.mutationTokens.set(userId, Symbol('mutation'));
		}
	}

	public hasUser(userId: number) {
		return this.users.has(userId);
	}
}

const createHarness = () => {
	const primaryRuntime = new FakeJoinRuntime(PRIMARY_CHANNEL_ID);
	const secondaryRuntime = new FakeJoinRuntime(SECONDARY_CHANNEL_ID);
	const runtimes = new Map([
		[PRIMARY_CHANNEL_ID, primaryRuntime],
		[SECONDARY_CHANNEL_ID, secondaryRuntime],
	]);
	const order: string[] = [];
	const events: TVoiceJoinPresenceEvent[] = [];
	const stats = { commits: 0, disposals: 0, responses: 0 };
	const observations: {
		pairs: unknown[];
		finishes: unknown[];
	} = { pairs: [], finishes: [] };
	let binding: TVoiceJoinBinding = {};
	let latestMutationSeq: number | undefined;
	let preparationAttempt = 0;
	const connectionIdentity = {};
	const attemptRegistry = createVoiceSessionAttemptRegistry();
	const controls: {
		resolveTarget: (channelId: number) => Promise<{ channel: { id: number; name: string }; runtime: FakeJoinRuntime }>;
		prepareProducer: (attempt: number) => Promise<void>;
		prepareConsumer: (attempt: number) => Promise<void>;
		beforePreparationReturn: (attempt: number) => Promise<void>;
		onCommit: (attempt: number) => void;
		onResponse: (attempt: number) => void;
	} = {
		resolveTarget: async (channelId) => {
			order.push('target');
			const runtime = runtimes.get(channelId);

			if (!runtime) {
				throw new Error('Target runtime missing');
			}

			return { channel: { id: channelId, name: `Voice ${channelId}` }, runtime };
		},
		prepareProducer: async (attempt) => {
			order.push(`prepare:${attempt}:producer`);
		},
		prepareConsumer: async (attempt) => {
			order.push(`prepare:${attempt}:consumer`);
		},
		beforePreparationReturn: async (attempt) => {
			order.push(`prepare:${attempt}:ready`);
		},
		onCommit: () => {},
		onResponse: () => {},
	};
	const service = createVoiceJoinService({
		findRuntimeByChannelId: (channelId) => runtimes.get(channelId),
		findRuntimeByUserId: (userId) => [...runtimes.values()].find((runtime) => runtime.hasUser(userId)),
		attemptRegistry,
		prepareBootstrap: async ({ runtime, userId, pairObserver }) => {
			preparationAttempt += 1;
			const attempt = preparationAttempt;
			let state: 'prepared' | 'committed' | 'disposed' = 'prepared';
			order.push(`prepare:${attempt}:start`);
			await Promise.all([controls.prepareProducer(attempt), controls.prepareConsumer(attempt)]);
			await controls.beforePreparationReturn(attempt);
			pairObserver?.({ outcome: 'prepared' });

			return {
				assertCommittable: () => {
					if (state !== 'prepared') {
						throw new Error('Preparation is not committable');
					}
				},
				commit: () => {
					if (state !== 'prepared') {
						throw new Error('Preparation is not committable');
					}

					state = 'committed';
					pairObserver?.({ outcome: 'committed' });
					stats.commits += 1;
					order.push(`prepare:${attempt}:commit`);
					controls.onCommit(attempt);
				},
				dispose: () => {
					if (state !== 'prepared') {
						return;
					}

					state = 'disposed';
					pairObserver?.({ outcome: 'disposed', cause: 'request_cleanup' });
					stats.disposals += 1;
					order.push(`prepare:${attempt}:dispose`);
				},
				buildCommittedResponse: () => {
					stats.responses += 1;
					order.push(`prepare:${attempt}:response`);
					controls.onResponse(attempt);
					return { attempt, joined: runtime.hasUser(userId) };
				},
			};
		},
		observer: {
			startAttempt: () => ({
				pairObserver: (event) => observations.pairs.push(event),
				finish: (result) => observations.finishes.push(result),
			}),
		},
		logJoined: () => order.push('log:joined'),
		logReplaced: () => order.push('log:replaced'),
	});

	const request = (overrides: { channelId?: number; mutationSeq?: number; signal?: AbortSignal } = {}) => ({
		channelId: overrides.channelId ?? PRIMARY_CHANNEL_ID,
		state: { micMuted: true, soundMuted: false },
		mutationSeq: overrides.mutationSeq,
		user: { id: 1, name: 'Test user' },
		signal: overrides.signal,
		context: {
			resolveTarget: controls.resolveTarget,
			getClientInstanceId: () => 'client-a',
			getConnectionIdentity: () => connectionIdentity,
			registerMutation: (mutationSeq: number | undefined) => {
				if (mutationSeq === undefined) {
					return true;
				}

				if (latestMutationSeq !== undefined && mutationSeq < latestMutationSeq) {
					return false;
				}

				latestMutationSeq = mutationSeq;
				return true;
			},
			isMutationCurrent: (mutationSeq: number | undefined) =>
				mutationSeq === undefined || latestMutationSeq === mutationSeq,
			getBinding: () => binding,
			bindVoiceSession: (channelId: number, sessionIncarnation: symbol) => {
				binding = { channelId, sessionIncarnation };
				order.push('binding:set');
			},
			clearBindingIfMatches: (capturedBinding: TVoiceJoinBinding) => {
				if (
					binding.channelId === capturedBinding.channelId &&
					binding.sessionIncarnation === capturedBinding.sessionIncarnation
				) {
					binding = {};
				}
			},
			publishPresence: (event: TVoiceJoinPresenceEvent) => {
				events.push(event);
				order.push(`presence:${event.type}`);
			},
		},
	});

	return {
		service,
		attemptRegistry,
		request,
		controls,
		order,
		events,
		stats,
		observations,
		primaryRuntime,
		secondaryRuntime,
		getBinding: () => binding,
		setBinding: (nextBinding: TVoiceJoinBinding) => {
			binding = nextBinding;
		},
	};
};

describe('voice join service', () => {
	test('prepares privately before committing fresh membership, binding, presence, and response', async () => {
		const harness = createHarness();

		const result = await harness.service.join(harness.request({ mutationSeq: 1 }));

		expect(result).toEqual({ attempt: 1, joined: true });
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.stats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
		expect(harness.observations).toEqual({
			pairs: [{ outcome: 'prepared' }, { outcome: 'committed' }],
			finishes: [{ path: 'fresh', outcome: 'succeeded' }],
		});
		expect(harness.order).toEqual([
			'target',
			'prepare:1:start',
			'prepare:1:producer',
			'prepare:1:consumer',
			'prepare:1:ready',
			'prepare:1:commit',
			'binding:set',
			'presence:join',
			'log:joined',
			'prepare:1:response',
		]);
	});

	test('same-channel replacement preserves leave, session-replaced, join ordering and mints an incarnation', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const previousIdentity = harness.primaryRuntime.getVoiceSessionIdentity(1);
		if (!previousIdentity) {
			throw new Error('Expected previous identity');
		}
		harness.setBinding({ channelId: PRIMARY_CHANNEL_ID, sessionIncarnation: previousIdentity.incarnation });

		await harness.service.join(harness.request({ mutationSeq: 1 }));

		const nextIdentity = harness.primaryRuntime.getVoiceSessionIdentity(1);
		expect(nextIdentity?.incarnation).not.toBe(previousIdentity.incarnation);
		expect(harness.events.map((event) => event.type)).toEqual(['leave', 'session-replaced', 'join']);
		expect(harness.events[0]).toMatchObject({ reconnecting: true });
		expect(harness.events[2]).toMatchObject({ reconnecting: true });
	});

	test('cross-channel replacement commits the target once with non-reconnecting event semantics', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const previousIdentity = harness.primaryRuntime.getVoiceSessionIdentity(1);
		harness.setBinding({ channelId: PRIMARY_CHANNEL_ID, sessionIncarnation: previousIdentity?.incarnation });

		await harness.service.join(harness.request({ channelId: SECONDARY_CHANNEL_ID, mutationSeq: 1 }));

		expect(harness.primaryRuntime.hasUser(1)).toBe(false);
		expect(harness.secondaryRuntime.hasUser(1)).toBe(true);
		expect(harness.stats.commits).toBe(1);
		expect(harness.events.map((event) => event.type)).toEqual(['leave', 'session-replaced', 'join']);
		expect(harness.events[0]).toMatchObject({ reconnecting: false });
		expect(harness.events[2]).toMatchObject({ reconnecting: false });
	});

	test('preparation failure leaves the old session, binding, and presence untouched', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const oldIdentity = harness.primaryRuntime.getVoiceSessionIdentity(1);
		const oldBinding = { channelId: PRIMARY_CHANNEL_ID, sessionIncarnation: oldIdentity?.incarnation };
		harness.setBinding(oldBinding);
		const failure = new Error('Producer allocation failed');
		harness.controls.prepareProducer = async () => {
			throw failure;
		};

		await expect(
			harness.service.join(harness.request({ channelId: SECONDARY_CHANNEL_ID, mutationSeq: 1 })),
		).rejects.toBe(failure);
		expect(harness.primaryRuntime.getVoiceSessionIdentity(1)).toEqual(oldIdentity);
		expect(harness.secondaryRuntime.hasUser(1)).toBe(false);
		expect(harness.getBinding()).toEqual(oldBinding);
		expect(harness.events).toEqual([]);
	});

	test('rejects a prepared join when a restore or rebuild rotates the captured transport identity', async () => {
		const harness = createHarness();
		harness.primaryRuntime.addUser(1, { micMuted: false, soundMuted: false });
		const ready = createDeferred();
		const release = createDeferred();
		harness.controls.beforePreparationReturn = async () => {
			ready.resolve();
			await release.promise;
		};
		const join = harness.service.join(harness.request({ channelId: SECONDARY_CHANNEL_ID, mutationSeq: 1 }));
		await ready.promise;
		harness.primaryRuntime.rotateTransportIdentity(1);
		release.resolve();

		await expect(join).rejects.toBeInstanceOf(VoiceJoinSupersededError);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.secondaryRuntime.hasUser(1)).toBe(false);
		expect(harness.stats).toEqual({ commits: 0, disposals: 1, responses: 0 });
		expect(harness.events).toEqual([]);
	});

	test('post-commit abort and response failure retain runtime ownership', async () => {
		const abortHarness = createHarness();
		const abortController = new AbortController();
		abortHarness.controls.onCommit = () => abortController.abort();

		await expect(
			abortHarness.service.join(abortHarness.request({ mutationSeq: 1, signal: abortController.signal })),
		).resolves.toEqual({ attempt: 1, joined: true });
		expect(abortHarness.primaryRuntime.hasUser(1)).toBe(true);
		expect(abortHarness.stats.disposals).toBe(0);

		const responseHarness = createHarness();
		const responseFailure = new Error('Response failed');
		responseHarness.controls.onResponse = () => {
			throw responseFailure;
		};

		await expect(responseHarness.service.join(responseHarness.request({ mutationSeq: 1 }))).rejects.toBe(
			responseFailure,
		);
		expect(responseHarness.primaryRuntime.hasUser(1)).toBe(true);
		expect(responseHarness.stats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(responseHarness.observations).toEqual({
			pairs: [{ outcome: 'prepared' }, { outcome: 'committed' }],
			finishes: [{ path: 'fresh', outcome: 'postcommit_response_failed', error: responseFailure }],
		});
	});

	test('does not let a later background restore supersede an active manual join', async () => {
		const harness = createHarness();
		const joinReady = createDeferred();
		const releaseJoin = createDeferred();
		harness.controls.beforePreparationReturn = async () => {
			joinReady.resolve();
			await releaseJoin.promise;
		};
		const join = harness.service.join(harness.request({ mutationSeq: 1 }));
		await joinReady.promise;
		let restoreStarted = false;
		const owner = getVoiceSessionAttemptOwner(1, 'client-a', {});

		await expect(
			harness.attemptRegistry.runLatest(owner, { kind: 'restore' }, async () => {
				restoreStarted = true;
				return undefined;
			}),
		).rejects.toBeInstanceOf(VoiceSessionAttemptSupersededError);
		expect(restoreStarted).toBe(false);

		releaseJoin.resolve();
		await expect(join).resolves.toEqual({ attempt: 1, joined: true });
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.stats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
	});

	test('manual join supersedes an active background restore and leaves its private cleanup scoped', async () => {
		const harness = createHarness();
		const restoreReady = createDeferred();
		const releaseRestore = createDeferred();
		const owner = getVoiceSessionAttemptOwner(1, 'client-a', {});
		let restoreDisposals = 0;
		const restore = harness.attemptRegistry
			.runLatest(owner, { kind: 'restore' }, async (attempt) => {
				restoreReady.resolve();
				try {
					await releaseRestore.promise;
					attempt.assertCurrent();
				} finally {
					restoreDisposals += 1;
				}
			})
			.catch((error: unknown) => error);
		await restoreReady.promise;

		await expect(harness.service.join(harness.request({ mutationSeq: 1 }))).resolves.toEqual({
			attempt: 1,
			joined: true,
		});
		releaseRestore.resolve();

		expect(await restore).toBeInstanceOf(VoiceSessionAttemptSupersededError);
		expect(restoreDisposals).toBe(1);
		expect(harness.primaryRuntime.hasUser(1)).toBe(true);
		expect(harness.stats).toEqual({ commits: 1, disposals: 0, responses: 1 });
		expect(harness.events.map((event) => event.type)).toEqual(['join']);
	});
});

type TBarrier = {
	name: string;
	expectedDisposals: number;
	install: (harness: ReturnType<typeof createHarness>) => { entered: Promise<void>; release: () => void };
};

const barriers: TBarrier[] = [
	{
		name: 'before target resolution',
		expectedDisposals: 0,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			const original = harness.controls.resolveTarget;
			let calls = 0;
			harness.controls.resolveTarget = async (channelId) => {
				calls += 1;
				if (calls === 1) {
					entered.resolve();
					await release.promise;
				}
				return original(channelId);
			};
			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'during producer allocation',
		expectedDisposals: 1,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			harness.controls.prepareProducer = async (attempt) => {
				if (attempt === 1) {
					entered.resolve();
					await release.promise;
				}
			};
			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'during consumer allocation',
		expectedDisposals: 1,
		install: (harness) => {
			const entered = createDeferred();
			const release = createDeferred();
			harness.controls.prepareConsumer = async (attempt) => {
				if (attempt === 1) {
					entered.resolve();
					await release.promise;
				}
			};
			return { entered: entered.promise, release: () => release.resolve() };
		},
	},
	{
		name: 'after full preparation before final checks',
		expectedDisposals: 1,
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

describe('voice join cancellation matrix', () => {
	for (const barrier of barriers) {
		test(`cancels ${barrier.name} without shared side effects`, async () => {
			const harness = createHarness();
			const control = barrier.install(harness);
			const abortController = new AbortController();
			const join = harness.service.join(harness.request({ mutationSeq: 1, signal: abortController.signal }));
			await control.entered;
			abortController.abort();
			control.release();

			await expect(join).rejects.toBeInstanceOf(VoiceSessionAttemptCancelledError);
			expect(harness.primaryRuntime.hasUser(1)).toBe(false);
			expect(harness.stats.commits).toBe(0);
			expect(harness.stats.disposals).toBe(barrier.expectedDisposals);
			expect(harness.events).toEqual([]);
			expect(harness.getBinding()).toEqual({});
		});

		test(`supersedes ${barrier.name} and commits only the newest join`, async () => {
			const harness = createHarness();
			const control = barrier.install(harness);
			const staleJoin = harness.service.join(harness.request({ mutationSeq: 1 }));
			const staleJoinResult = staleJoin.catch((error: unknown) => error);
			await control.entered;
			const currentJoin = await harness.service.join(harness.request({ mutationSeq: 2 }));
			control.release();

			expect(currentJoin).toEqual(expect.objectContaining({ joined: true }));
			expect(await staleJoinResult).toBeInstanceOf(VoiceSessionAttemptSupersededError);
			expect(harness.primaryRuntime.hasUser(1)).toBe(true);
			expect(harness.stats.commits).toBe(1);
			expect(harness.stats.disposals).toBe(barrier.expectedDisposals);
			expect(harness.events.map((event) => event.type)).toEqual(['join']);
		});
	}
});
