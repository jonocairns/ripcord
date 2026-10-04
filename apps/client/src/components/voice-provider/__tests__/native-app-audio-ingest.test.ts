/**
 * Unit tests for the produce-and-commit tail of startNativeAppAudioIngest.
 *
 * These tests currently reproduce the native provider control flow with
 * injected mocks. The share-audio extraction replaces this copy with tests
 * importing the production controller.
 *
 * What we verify: once produceAppAudio reports a live producer, the attempt only
 * commits (sets the active ref, returns 'published') while it still owns the
 * current generation AND the publish intent is still set. If the share was
 * stopped (intent cleared) or a newer attempt superseded this one while
 * produceAppAudio was in flight, it must tear its own attempt down and report
 * 'abandoned' instead of stranding a live SCREEN_AUDIO producer + RTP sender.
 */

import { describe, expect, it, mock } from 'bun:test';

type TProduceResult = { producerId: string } | { fallback: true };

type TIngestCommitDeps = {
	ownsCurrentAttempt: () => boolean;
	hasPublishIntent: () => boolean;
	produce: () => Promise<TProduceResult>;
	setNativeActive: () => void;
	teardownNativeAttempt: () => Promise<void>;
};

// Mirror of the produce → commit/abandon/fallback tail of startNativeAppAudioIngest.
const runProduceAndCommit = async (deps: TIngestCommitDeps): Promise<'published' | 'abandoned' | 'fallback'> => {
	const result = await deps.produce();

	if ('producerId' in result) {
		if (!deps.ownsCurrentAttempt() || !deps.hasPublishIntent()) {
			await deps.teardownNativeAttempt();
			return 'abandoned';
		}

		deps.setNativeActive();
		return 'published';
	}

	// No first media within the gate: tear down and let the caller use the worklet.
	await deps.teardownNativeAttempt();
	return 'fallback';
};

const makeDeps = (overrides: Partial<TIngestCommitDeps> = {}): TIngestCommitDeps => ({
	ownsCurrentAttempt: () => true,
	hasPublishIntent: () => true,
	produce: mock(() => Promise.resolve<TProduceResult>({ producerId: 'producer-1' })),
	setNativeActive: mock(() => {}),
	teardownNativeAttempt: mock(() => Promise.resolve()),
	...overrides,
});

describe('startNativeAppAudioIngest produce/commit', () => {
	it('commits when the attempt still owns the generation and intent', async () => {
		const deps = makeDeps();

		expect(await runProduceAndCommit(deps)).toBe('published');
		expect((deps.setNativeActive as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
	});

	it('abandons and tears down when the share is stopped while produce is in flight', async () => {
		let intent = true;
		const deps = makeDeps({
			hasPublishIntent: () => intent,
			// The user stops sharing (clearing intent) before produce resolves.
			produce: mock(() => {
				intent = false;
				return Promise.resolve<TProduceResult>({ producerId: 'producer-1' });
			}),
		});

		expect(await runProduceAndCommit(deps)).toBe('abandoned');
		expect((deps.setNativeActive as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});

	it('abandons and tears down when a newer attempt supersedes this generation', async () => {
		const deps = makeDeps({ ownsCurrentAttempt: () => false });

		expect(await runProduceAndCommit(deps)).toBe('abandoned');
		expect((deps.setNativeActive as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});

	it('falls back without committing when no first media is observed', async () => {
		const deps = makeDeps({
			produce: mock(() => Promise.resolve<TProduceResult>({ fallback: true })),
		});

		expect(await runProduceAndCommit(deps)).toBe('fallback');
		expect((deps.setNativeActive as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});
});

type TNativeAttemptDeps = {
	startCapture: () => Promise<{ sessionId: string }>;
	setSession: () => void;
	createIngest: () => Promise<{ id: string }>;
	startRtp: () => Promise<void>;
	produce: () => Promise<TProduceResult>;
	setNativeActive: () => void;
	teardownNativeAttempt: () => Promise<void>;
	ownsCurrentAttempt: () => boolean;
	hasPublishIntent: () => boolean;
};

// Mirror of the native setup gates before produceAppAudio. Every awaited step
// must re-check ownership before mutating the next shared resource.
const runNativeAttemptSetup = async (deps: TNativeAttemptDeps): Promise<'published' | 'abandoned' | 'fallback'> => {
	const ownsPublishIntent = () => deps.ownsCurrentAttempt() && deps.hasPublishIntent();

	await deps.startCapture();
	if (!ownsPublishIntent()) {
		await deps.teardownNativeAttempt();
		return 'abandoned';
	}

	deps.setSession();
	await deps.createIngest();
	if (!ownsPublishIntent()) {
		await deps.teardownNativeAttempt();
		return 'abandoned';
	}

	await deps.startRtp();
	if (!ownsPublishIntent()) {
		await deps.teardownNativeAttempt();
		return 'abandoned';
	}

	return runProduceAndCommit(deps);
};

const makeAttemptDeps = (overrides: Partial<TNativeAttemptDeps> = {}): TNativeAttemptDeps => ({
	startCapture: mock(() => Promise.resolve({ sessionId: 'session-1' })),
	setSession: mock(() => {}),
	createIngest: mock(() => Promise.resolve({ id: 'transport-1' })),
	startRtp: mock(() => Promise.resolve()),
	produce: mock(() => Promise.resolve<TProduceResult>({ producerId: 'producer-1' })),
	setNativeActive: mock(() => {}),
	teardownNativeAttempt: mock(() => Promise.resolve()),
	ownsCurrentAttempt: () => true,
	hasPublishIntent: () => true,
	...overrides,
});

describe('startNativeAppAudioIngest setup gates', () => {
	it('abandons before storing the session when capture resolves after the attempt is superseded', async () => {
		const deps = makeAttemptDeps({ ownsCurrentAttempt: () => false });

		expect(await runNativeAttemptSetup(deps)).toBe('abandoned');
		expect((deps.setSession as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.createIngest as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});

	it('abandons before starting RTP when ingest allocation resolves after intent is cleared', async () => {
		let intent = true;
		const deps = makeAttemptDeps({
			createIngest: mock(() => {
				intent = false;
				return Promise.resolve({ id: 'transport-1' });
			}),
			hasPublishIntent: () => intent,
		});

		expect(await runNativeAttemptSetup(deps)).toBe('abandoned');
		expect((deps.startRtp as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.produce as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});

	it('abandons before produce when RTP start resolves after a newer attempt takes over', async () => {
		let ownsAttempt = true;
		const deps = makeAttemptDeps({
			startRtp: mock(() => {
				ownsAttempt = false;
				return Promise.resolve();
			}),
			ownsCurrentAttempt: () => ownsAttempt,
		});

		expect(await runNativeAttemptSetup(deps)).toBe('abandoned');
		expect((deps.produce as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
		expect((deps.teardownNativeAttempt as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
	});
});
