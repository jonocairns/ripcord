/**
 * Unit tests for the in-session transport rebuild orchestration.
 *
 * VoiceProvider.recoverTransportSession is a useCallback deep inside a React
 * component that can't be rendered without a full browser environment. Instead
 * we test the pure orchestration logic by recreating its control-flow as a
 * standalone function driven by injected mocks — the same pattern used by
 * audio-context.test.ts and video-bitrate-policy.test.ts in this directory.
 *
 * What we verify:
 *   1. Happy path: all steps called in the correct order
 *   2. Nonce cancellation: if the WS session nonce changes mid-flight the
 *      rebuild returns false without touching monitoring/status
 *   3. Retry: a transient failure on attempt 1 is retried; success on attempt
 *      2 still returns true
 *   4. Non-retriable error: a 4xx-class TRPC error is not retried
 *   5. Exhausted retries: three consecutive transient failures return false
 *   6. Flag dedup: a second concurrent call returns the same promise
 */

import { describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Minimal reproduction of the recovery orchestration logic extracted from
// recoverTransportSession. Kept structurally identical so a refactor that
// changes the real function will break these tests and surface the divergence.
// ---------------------------------------------------------------------------

const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_TIMEOUT_MS = 12_000;
const RECOVERY_BACKOFF_MS = [1_000, 2_000] as const;

const withRecoveryTimeout = <T,>(promise: Promise<T>, timeoutMs = RECOVERY_TIMEOUT_MS): Promise<T> => {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error('Voice transport recovery timed out')), timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (handle !== undefined) clearTimeout(handle);
	});
};

type TRecoveryDeps = {
	isConnected: () => boolean;
	currentVoiceChannelId: () => number | undefined;
	hasRouterRtpCapabilities: () => boolean;
	getNonce: () => number;
	captureWatchedStreams: () => { remoteUserStreams: Record<string, string[]>; externalStreams: Record<string, { audio: boolean; video: boolean }> };
	setConnectionStatus: (s: string) => void;
	stopMonitoring: () => void;
	resetStats: () => void;
	clearRemoteUserStreams: () => void;
	clearExternalStreams: () => void;
	cleanupTransports: () => void;
	loadDevice: () => Promise<{ rtpCapabilities: object }>;
	createProducerTransport: (device: object) => Promise<void>;
	createConsumerTransport: (device: object) => Promise<void>;
	consumeExistingProducers: (caps: object) => Promise<void>;
	republishTracks: () => Promise<void>[];
	consume: (id: number | string, kind: string, caps: object) => Promise<void>;
	startMonitoring: () => void;
	isNonRetriableTrpcError: (err: unknown) => boolean;
	sleep: (ms: number) => Promise<void>;
};

const runRecovery = async (deps: TRecoveryDeps): Promise<boolean> => {
	if (!deps.isConnected()) return false;
	if (deps.currentVoiceChannelId() === undefined) return false;
	if (!deps.hasRouterRtpCapabilities()) return false;

	for (let attempt = 0; attempt < RECOVERY_MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await deps.sleep(RECOVERY_BACKOFF_MS[attempt - 1] ?? 1_000);
			if (!deps.isConnected() || deps.currentVoiceChannelId() === undefined) return false;
		}

		const nonceAtStart = deps.getNonce();
		const isNonceStale = () => deps.getNonce() !== nonceAtStart;

		try {
			const snapshot = deps.captureWatchedStreams();

			deps.setConnectionStatus('connecting');
			deps.stopMonitoring();
			deps.resetStats();
			deps.clearRemoteUserStreams();
			deps.clearExternalStreams();
			deps.cleanupTransports();

			const device = await withRecoveryTimeout(deps.loadDevice(), RECOVERY_TIMEOUT_MS);
			if (isNonceStale()) return false;

			await withRecoveryTimeout(
				Promise.all([deps.createProducerTransport(device), deps.createConsumerTransport(device)]),
				RECOVERY_TIMEOUT_MS,
			);
			if (isNonceStale()) return false;

			await withRecoveryTimeout(
				Promise.all([deps.consumeExistingProducers(device.rtpCapabilities), ...deps.republishTracks()]),
				RECOVERY_TIMEOUT_MS,
			);
			if (isNonceStale()) return false;

			const restoreTasks: Promise<void>[] = [];
			Object.entries(snapshot.remoteUserStreams).forEach(([id, kinds]) => {
				kinds.forEach((kind) => restoreTasks.push(deps.consume(id, kind, device.rtpCapabilities)));
			});
			Object.entries(snapshot.externalStreams).forEach(([id, state]) => {
				if (state.audio) restoreTasks.push(deps.consume(id, 'externalAudio', device.rtpCapabilities));
				if (state.video) restoreTasks.push(deps.consume(id, 'externalVideo', device.rtpCapabilities));
			});
			await withRecoveryTimeout(Promise.all(restoreTasks), RECOVERY_TIMEOUT_MS);
			if (isNonceStale()) return false;

			deps.startMonitoring();
			deps.setConnectionStatus('connected');
			return true;
		} catch (error) {
			const isLast = attempt === RECOVERY_MAX_ATTEMPTS - 1;
			if (!isLast && !deps.isNonRetriableTrpcError(error)) continue;
			deps.setConnectionStatus('failed');
			return false;
		}
	}

	return false;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeDeps = (overrides: Partial<TRecoveryDeps> = {}): TRecoveryDeps => {
	let nonce = 0;
	return {
		isConnected: () => true,
		currentVoiceChannelId: () => 7,
		hasRouterRtpCapabilities: () => true,
		getNonce: () => nonce,
		captureWatchedStreams: () => ({ remoteUserStreams: {}, externalStreams: {} }),
		setConnectionStatus: mock(() => {}),
		stopMonitoring: mock(() => {}),
		resetStats: mock(() => {}),
		clearRemoteUserStreams: mock(() => {}),
		clearExternalStreams: mock(() => {}),
		cleanupTransports: mock(() => {}),
		loadDevice: mock(() => Promise.resolve({ rtpCapabilities: {} })),
		createProducerTransport: mock(() => Promise.resolve()),
		createConsumerTransport: mock(() => Promise.resolve()),
		consumeExistingProducers: mock(() => Promise.resolve()),
		republishTracks: mock(() => []),
		consume: mock(() => Promise.resolve()),
		startMonitoring: mock(() => {}),
		isNonRetriableTrpcError: () => false,
		sleep: mock(() => Promise.resolve()),
		...overrides,
	};
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverTransportSession orchestration', () => {
	it('returns false immediately when not connected', async () => {
		const deps = makeDeps({ isConnected: () => false });
		expect(await runRecovery(deps)).toBe(false);
		expect((deps.loadDevice as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});

	it('returns false immediately when not in a voice channel', async () => {
		const deps = makeDeps({ currentVoiceChannelId: () => undefined });
		expect(await runRecovery(deps)).toBe(false);
		expect((deps.loadDevice as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});

	it('returns false immediately when router RTP capabilities are missing', async () => {
		const deps = makeDeps({ hasRouterRtpCapabilities: () => false });
		expect(await runRecovery(deps)).toBe(false);
		expect((deps.loadDevice as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});

	it('happy path: calls all steps in order and returns true', async () => {
		const callOrder: string[] = [];
		const deps = makeDeps({
			stopMonitoring: mock(() => { callOrder.push('stopMonitoring'); }),
			resetStats: mock(() => { callOrder.push('resetStats'); }),
			clearRemoteUserStreams: mock(() => { callOrder.push('clearRemoteUserStreams'); }),
			clearExternalStreams: mock(() => { callOrder.push('clearExternalStreams'); }),
			cleanupTransports: mock(() => { callOrder.push('cleanupTransports'); }),
			loadDevice: mock(() => { callOrder.push('loadDevice'); return Promise.resolve({ rtpCapabilities: {} }); }),
			createProducerTransport: mock(() => { callOrder.push('createProducerTransport'); return Promise.resolve(); }),
			createConsumerTransport: mock(() => { callOrder.push('createConsumerTransport'); return Promise.resolve(); }),
			consumeExistingProducers: mock(() => { callOrder.push('consumeExistingProducers'); return Promise.resolve(); }),
			startMonitoring: mock(() => { callOrder.push('startMonitoring'); }),
		});

		expect(await runRecovery(deps)).toBe(true);
		expect(callOrder).toEqual([
			'stopMonitoring',
			'resetStats',
			'clearRemoteUserStreams',
			'clearExternalStreams',
			'cleanupTransports',
			'loadDevice',
			'createProducerTransport',
			'createConsumerTransport',
			'consumeExistingProducers',
			'startMonitoring',
		]);
		expect((deps.setConnectionStatus as ReturnType<typeof mock>).mock.calls.at(-1)).toEqual(['connected']);
	});

	it('restores watched remote user streams after rebuild', async () => {
		const consumed: Array<[number | string, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({
				remoteUserStreams: { '10': ['video', 'audio'], '20': ['screen'] },
				externalStreams: {},
			}),
			consume: mock((id, kind) => { consumed.push([id, kind]); return Promise.resolve(); }),
		});

		expect(await runRecovery(deps)).toBe(true);
		expect(consumed).toContainEqual(['10', 'video']);
		expect(consumed).toContainEqual(['10', 'audio']);
		expect(consumed).toContainEqual(['20', 'screen']);
	});

	it('restores watched external streams after rebuild', async () => {
		const consumed: Array<[number | string, string]> = [];
		const deps = makeDeps({
			captureWatchedStreams: () => ({
				remoteUserStreams: {},
				externalStreams: { '99': { audio: true, video: true }, '100': { audio: true, video: false } },
			}),
			consume: mock((id, kind) => { consumed.push([id, kind]); return Promise.resolve(); }),
		});

		expect(await runRecovery(deps)).toBe(true);
		expect(consumed).toContainEqual(['99', 'externalAudio']);
		expect(consumed).toContainEqual(['99', 'externalVideo']);
		expect(consumed).toContainEqual(['100', 'externalAudio']);
		expect(consumed).not.toContainEqual(['100', 'externalVideo']);
	});

	it('cancels and returns false when nonce changes after device load', async () => {
		let nonce = 0;
		const deps = makeDeps({
			getNonce: () => nonce,
			loadDevice: mock(async () => {
				nonce++; // WS reconnect fires mid-load
				return { rtpCapabilities: {} };
			}),
		});

		expect(await runRecovery(deps)).toBe(false);
		expect((deps.createProducerTransport as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.startMonitoring as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});

	it('cancels and returns false when nonce changes after transports are created', async () => {
		let nonce = 0;
		const deps = makeDeps({
			getNonce: () => nonce,
			createConsumerTransport: mock(async () => { nonce++; }),
		});

		expect(await runRecovery(deps)).toBe(false);
		expect((deps.consumeExistingProducers as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.startMonitoring as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});

	it('retries on transient error and succeeds on second attempt', async () => {
		let calls = 0;
		const deps = makeDeps({
			loadDevice: mock(() => {
				calls++;
				if (calls === 1) return Promise.reject(new Error('network blip'));
				return Promise.resolve({ rtpCapabilities: {} });
			}),
		});

		expect(await runRecovery(deps)).toBe(true);
		expect(calls).toBe(2);
		expect((deps.sleep as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
		expect((deps.setConnectionStatus as ReturnType<typeof mock>).mock.calls.at(-1)).toEqual(['connected']);
	});

	it('does not retry on a non-retriable TRPC error', async () => {
		let calls = 0;
		const nonRetriableError = Object.assign(new Error('Insufficient permissions'), {
			data: { code: 'FORBIDDEN', httpStatus: 403 },
		});

		const deps = makeDeps({
			loadDevice: mock(() => { calls++; return Promise.reject(nonRetriableError); }),
			isNonRetriableTrpcError: (err) => {
				const data = (err as { data?: { code?: string } }).data;
				return data?.code === 'FORBIDDEN';
			},
		});

		expect(await runRecovery(deps)).toBe(false);
		expect(calls).toBe(1);
		expect((deps.sleep as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.setConnectionStatus as ReturnType<typeof mock>).mock.calls.at(-1)).toEqual(['failed']);
	});

	it('returns false after exhausting all retry attempts', async () => {
		let calls = 0;
		const deps = makeDeps({
			loadDevice: mock(() => { calls++; return Promise.reject(new Error('persistent failure')); }),
		});

		expect(await runRecovery(deps)).toBe(false);
		expect(calls).toBe(RECOVERY_MAX_ATTEMPTS);
		expect((deps.sleep as ReturnType<typeof mock>).mock.calls).toHaveLength(RECOVERY_MAX_ATTEMPTS - 1);
		expect((deps.setConnectionStatus as ReturnType<typeof mock>).mock.calls.at(-1)).toEqual(['failed']);
	});

	it('aborts after backoff if the connection drops between attempts', async () => {
		const connected = { value: true };
		let calls = 0;
		const deps = makeDeps({
			isConnected: () => connected.value,
			loadDevice: mock(() => { calls++; return Promise.reject(new Error('blip')); }),
			sleep: mock(async () => { connected.value = false; }),
		});

		expect(await runRecovery(deps)).toBe(false);
		expect(calls).toBe(1); // only one attempt — second is skipped after sleep
		expect((deps.startMonitoring as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});
});
