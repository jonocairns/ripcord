/**
 * Regression tests for watch-intent restoration on the WS-reconnect path.
 *
 * VoiceProvider's WS-reconnect effect is a useEffect deep inside a React
 * component that can't be rendered without a full browser environment, so —
 * following the same pattern as recover-transport-session.test.ts — we test the
 * pure orchestration logic by recreating its control-flow as a standalone
 * function driven by injected mocks.
 *
 * The bug this guards against:
 *   On WS reconnect, init() tears down transports, and cleanupTransports()
 *   resets the subscription ledger (clearAllPendingStreams), wiping every
 *   `desired` watch flag. consumeExistingProducers only auto-consumes audio;
 *   video / screen / screen-audio / external streams are re-consumed ONLY when
 *   the ledger still holds their `desired` intent — which init just erased. So
 *   without an explicit restore, watched streams stop and the user has to click
 *   "Watch" again. The fix snapshots watch intent BEFORE init and re-consumes
 *   each watched stream after consumeExistingProducers, mirroring the in-session
 *   transport-recovery path.
 */

import { describe, expect, it, mock } from 'bun:test';

type TWatchedStreamsSnapshot = {
	remoteUserStreams: Record<string, string[]>;
	externalStreams: Record<string, { audio: boolean; video: boolean }>;
};

type TReconnectDeps = {
	captureWatchedStreams: () => TWatchedStreamsSnapshot;
	restoreOrJoin: () => Promise<{ routerRtpCapabilities: object }>;
	// init() stands in for the real init(), whose teardown clears the ledger.
	init: () => Promise<void>;
	getRtpCapabilities: () => object | undefined;
	consumeExistingProducers: (caps: object) => Promise<void>;
	isWatchedRestoreCancelled: (id: number, kind: string) => boolean;
	consume: (id: number, kind: string, caps: object) => Promise<void>;
	clearRecovery: () => void;
};

// Structurally mirrors the happy-path control-flow of the WS-reconnect effect's
// restore sequence (index.tsx): snapshot once → restoreOrJoin → init (clears the
// ledger) → consumeExistingProducers → restore each watched stream from the
// snapshot. A refactor that drops the restore will fail these tests.
const runReconnectRestore = async (deps: TReconnectDeps): Promise<void> => {
	// Captured once, before init() wipes the ledger's `desired` intent.
	const watchedStreamsSnapshot = deps.captureWatchedStreams();

	await deps.restoreOrJoin();
	await deps.init();

	const currentRtpCapabilities = deps.getRtpCapabilities();

	if (currentRtpCapabilities) {
		await deps.consumeExistingProducers(currentRtpCapabilities);

		const restoreWatchTasks: Promise<unknown>[] = [];

		Object.entries(watchedStreamsSnapshot.remoteUserStreams).forEach(([remoteId, kinds]) => {
			const numericRemoteId = Number(remoteId);

			kinds.forEach((kind) => {
				if (deps.isWatchedRestoreCancelled(numericRemoteId, kind)) {
					return;
				}

				restoreWatchTasks.push(deps.consume(numericRemoteId, kind, currentRtpCapabilities));
			});
		});

		Object.entries(watchedStreamsSnapshot.externalStreams).forEach(([streamId, watchedState]) => {
			const numericStreamId = Number(streamId);

			if (watchedState.audio && !deps.isWatchedRestoreCancelled(numericStreamId, 'externalAudio')) {
				restoreWatchTasks.push(deps.consume(numericStreamId, 'externalAudio', currentRtpCapabilities));
			}

			if (watchedState.video && !deps.isWatchedRestoreCancelled(numericStreamId, 'externalVideo')) {
				restoreWatchTasks.push(deps.consume(numericStreamId, 'externalVideo', currentRtpCapabilities));
			}
		});

		if (restoreWatchTasks.length > 0) {
			await Promise.all(restoreWatchTasks);
		}
	}

	deps.clearRecovery();
};

const makeDeps = (overrides: Partial<TReconnectDeps> = {}): TReconnectDeps => ({
	captureWatchedStreams: () => ({ remoteUserStreams: {}, externalStreams: {} }),
	restoreOrJoin: mock(() => Promise.resolve({ routerRtpCapabilities: {} })),
	init: mock(() => Promise.resolve()),
	getRtpCapabilities: () => ({}),
	consumeExistingProducers: mock(() => Promise.resolve()),
	isWatchedRestoreCancelled: () => false,
	consume: mock(() => Promise.resolve()),
	clearRecovery: mock(() => {}),
	...overrides,
});

describe('voice WS-reconnect watch restoration', () => {
	it('re-consumes watched remote user streams after the ledger is wiped by init', async () => {
		const consumed: Array<[number, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({
				remoteUserStreams: { '10': ['video'], '20': ['screen', 'screenAudio'] },
				externalStreams: {},
			}),
			consume: mock((id, kind) => {
				consumed.push([id, kind]);
				return Promise.resolve();
			}),
		});

		await runReconnectRestore(deps);

		expect(consumed).toContainEqual([10, 'video']);
		expect(consumed).toContainEqual([20, 'screen']);
		expect(consumed).toContainEqual([20, 'screenAudio']);
	});

	it('re-consumes watched external streams, honouring per-track presence', async () => {
		const consumed: Array<[number, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({
				remoteUserStreams: {},
				externalStreams: { '99': { audio: true, video: true }, '100': { audio: true, video: false } },
			}),
			consume: mock((id, kind) => {
				consumed.push([id, kind]);
				return Promise.resolve();
			}),
		});

		await runReconnectRestore(deps);

		expect(consumed).toContainEqual([99, 'externalAudio']);
		expect(consumed).toContainEqual([99, 'externalVideo']);
		expect(consumed).toContainEqual([100, 'externalAudio']);
		expect(consumed).not.toContainEqual([100, 'externalVideo']);
	});

	it('captures the watch snapshot once, before init() clears the ledger', async () => {
		// The snapshot must be read before init(): a capture after init would see
		// the wiped ledger and restore nothing.
		let ledgerCleared = false;
		let captureCalls = 0;
		const consumed: Array<[number, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: (): TWatchedStreamsSnapshot => {
				captureCalls += 1;
				// Simulate reading the ledger: empty once init() has cleared it.
				return ledgerCleared
					? { remoteUserStreams: {}, externalStreams: {} }
					: { remoteUserStreams: { '10': ['screen'] }, externalStreams: {} };
			},
			init: mock(() => {
				ledgerCleared = true;
				return Promise.resolve();
			}),
			consume: mock((id, kind) => {
				consumed.push([id, kind]);
				return Promise.resolve();
			}),
		});

		await runReconnectRestore(deps);

		expect(captureCalls).toBe(1);
		expect(consumed).toContainEqual([10, 'screen']);
	});

	it('runs consumeExistingProducers before restoring watched streams', async () => {
		const order: string[] = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({ remoteUserStreams: { '10': ['video'] }, externalStreams: {} }),
			consumeExistingProducers: mock(() => {
				order.push('consumeExistingProducers');
				return Promise.resolve();
			}),
			consume: mock(() => {
				order.push('consume');
				return Promise.resolve();
			}),
		});

		await runReconnectRestore(deps);

		expect(order).toEqual(['consumeExistingProducers', 'consume']);
	});

	it('does not restore streams stopped after the watch snapshot is captured', async () => {
		const cancelled = new Set<string>();
		const consumed: Array<[number, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({
				remoteUserStreams: { '10': ['video'], '20': ['screen', 'screenAudio'] },
				externalStreams: { '99': { audio: true, video: true } },
			}),
			consumeExistingProducers: mock(() => {
				cancelled.add('20:screen');
				cancelled.add('20:screenAudio');
				cancelled.add('99:externalAudio');
				return Promise.resolve();
			}),
			isWatchedRestoreCancelled: (id, kind) => cancelled.has(`${id}:${kind}`),
			consume: mock((id, kind) => {
				consumed.push([id, kind]);
				return Promise.resolve();
			}),
		});

		await runReconnectRestore(deps);

		expect(consumed).toContainEqual([10, 'video']);
		expect(consumed).toContainEqual([99, 'externalVideo']);
		expect(consumed).not.toContainEqual([20, 'screen']);
		expect(consumed).not.toContainEqual([20, 'screenAudio']);
		expect(consumed).not.toContainEqual([99, 'externalAudio']);
	});

	it('does not restore audio through the snapshot path — audio is auto-consumed by consumeExistingProducers', async () => {
		// captureWatchedStreams excludes AUDIO by design, so the restore loop must
		// never issue a redundant audio consume that would double up on the
		// auto-consume in consumeExistingProducers.
		const consumed: Array<[number, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({ remoteUserStreams: { '10': ['video'] }, externalStreams: {} }),
			consume: mock((id, kind) => {
				consumed.push([id, kind]);
				return Promise.resolve();
			}),
		});

		await runReconnectRestore(deps);

		expect(consumed).not.toContainEqual([10, 'audio']);
		expect(consumed).toHaveLength(1);
	});

	it('skips restoration when RTP capabilities are unavailable', async () => {
		const deps = makeDeps({
			getRtpCapabilities: () => undefined,
			captureWatchedStreams: () => ({ remoteUserStreams: { '10': ['video'] }, externalStreams: {} }),
		});

		await runReconnectRestore(deps);

		expect((deps.consume as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.consumeExistingProducers as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		// Recovery still completes so the reconnect state is cleared.
		expect((deps.clearRecovery as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});

	it('completes cleanly with no watched streams', async () => {
		const deps = makeDeps();

		await runReconnectRestore(deps);

		expect((deps.consume as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.clearRecovery as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});
});
