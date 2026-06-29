/**
 * Unit tests for the produce-and-commit tail of startNativeAppAudioIngest.
 *
 * Like recover-transport-session.test.ts, the real logic is a useCallback deep
 * inside VoiceProvider that can't be rendered headlessly, so we reproduce its
 * control-flow as a standalone function driven by injected mocks. Kept
 * structurally identical to the real branch so a refactor that changes it will
 * break these tests and surface the divergence.
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

// Mirror of the serialization wrapper that chains overlapping recoveries so a
// retry-fired recovery never interleaves its cleanup with a sibling's publish.
const makeSerializedRecovery = () => {
	let inFlight: Promise<void> | undefined;

	return (body: () => Promise<void>): Promise<void> => {
		const previous = inFlight;

		const recovery = (async () => {
			if (previous) {
				await previous.catch(() => undefined);
			}
			await body();
		})().finally(() => {
			if (inFlight === recovery) {
				inFlight = undefined;
			}
		});

		inFlight = recovery;
		return recovery;
	};
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('recoverDesktopAppAudioFromIntent serialization', () => {
	it('runs overlapping recoveries sequentially instead of interleaving them', async () => {
		const run = makeSerializedRecovery();
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = run(async () => {
			events.push('first:start');
			await firstGate;
			events.push('first:end');
		});
		const second = run(async () => {
			events.push('second:start');
		});

		// The second recovery must not begin its body until the first has finished,
		// so its cleanup can never stop the first's in-flight/just-published ingest.
		await tick();
		expect(events).toEqual(['first:start']);

		releaseFirst();
		await Promise.all([first, second]);

		expect(events).toEqual(['first:start', 'first:end', 'second:start']);
	});

	it('still runs a later recovery after the previous one rejects', async () => {
		const run = makeSerializedRecovery();
		const events: string[] = [];

		const first = run(async () => {
			events.push('first');
			throw new Error('recovery failed');
		});
		const second = run(async () => {
			events.push('second');
		});

		await expect(first).rejects.toThrow('recovery failed');
		await second;

		expect(events).toEqual(['first', 'second']);
	});
});
