import { describe, expect, it, mock } from 'bun:test';
import { createDesktopAppAudioRecoveryController } from '../desktop-app-audio-recovery-controller';
import { mountDesktopAppAudioRecoveryController } from '../hooks/use-desktop-app-audio-recovery-lifecycle';

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

const createDeferred = <T = void>(): TDeferred<T> => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
};

const flushMicrotasks = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn += 1) {
		await Promise.resolve();
	}
};

describe('desktop app audio recovery controller', () => {
	it('stays reusable across lifecycle replay', async () => {
		const controller = createDesktopAppAudioRecoveryController();
		const runs: string[] = [];
		const replayCleanup = mountDesktopAppAudioRecoveryController(controller);

		await controller.recover(async () => {
			runs.push('first');
		});
		replayCleanup();

		const finalCleanup = mountDesktopAppAudioRecoveryController(controller);
		await controller.recover(async () => {
			runs.push('second');
		});
		finalCleanup();
		finalCleanup();

		expect(runs).toEqual(['first', 'second']);
	});

	it('invalidates a recovery queued behind an earlier promise before it can acquire media', async () => {
		const controller = createDesktopAppAudioRecoveryController();
		const cleanup = mountDesktopAppAudioRecoveryController(controller);
		const firstGate = createDeferred();
		const capture = mock(() => Promise.resolve());
		const first = controller.recover(async () => {
			await firstGate.promise;
		});
		const queued = controller.recover(async () => {
			await capture();
		});

		cleanup();
		firstGate.resolve();
		await Promise.all([first, queued]);

		expect(capture).not.toHaveBeenCalled();
	});

	it('fences deferred native startup and lets only a reactivated successor publish', async () => {
		const controller = createDesktopAppAudioRecoveryController();
		const firstCleanup = mountDesktopAppAudioRecoveryController(controller);
		const nativeCapture = createDeferred<{ sessionId: string }>();
		const stoppedSessions: string[] = [];
		const publishedSessions: string[] = [];
		const predecessor = controller.recover(async (lease) => {
			const session = await nativeCapture.promise;
			if (!lease.isCurrent()) {
				stoppedSessions.push(session.sessionId);
				return;
			}
			publishedSessions.push(session.sessionId);
		});

		firstCleanup();
		const finalCleanup = mountDesktopAppAudioRecoveryController(controller);
		const successor = controller.recover(async (lease) => {
			if (lease.isCurrent()) {
				publishedSessions.push('native-successor');
			}
		});

		nativeCapture.resolve({ sessionId: 'native-predecessor' });
		await Promise.all([predecessor, successor]);

		expect(stoppedSessions).toEqual(['native-predecessor']);
		expect(publishedSessions).toEqual(['native-successor']);
		finalCleanup();
	});

	it('fences deferred worklet fallback without destroying a successor pipeline', async () => {
		const controller = createDesktopAppAudioRecoveryController();
		const firstCleanup = mountDesktopAppAudioRecoveryController(controller);
		const workletStartup = createDeferred<{ id: string }>();
		const destroyedPipelines: string[] = [];
		let installedPipeline: string | undefined;
		const predecessor = controller.recover(async (lease) => {
			const pipeline = await workletStartup.promise;
			if (!lease.isCurrent()) {
				destroyedPipelines.push(pipeline.id);
				return;
			}
			installedPipeline = pipeline.id;
		});

		firstCleanup();
		const finalCleanup = mountDesktopAppAudioRecoveryController(controller);
		const successor = controller.recover(async (lease) => {
			if (lease.isCurrent()) {
				installedPipeline = 'worklet-successor';
			}
		});

		workletStartup.resolve({ id: 'worklet-predecessor' });
		await Promise.all([predecessor, successor]);
		await flushMicrotasks();

		expect(destroyedPipelines).toEqual(['worklet-predecessor']);
		expect(installedPipeline).toBe('worklet-successor');
		finalCleanup();
	});

	it('stops native-to-worklet fallback when the owning lifecycle is invalidated', async () => {
		const controller = createDesktopAppAudioRecoveryController();
		const cleanup = mountDesktopAppAudioRecoveryController(controller);
		const nativeFallback = createDeferred<'fallback'>();
		const startWorklet = mock(() => Promise.resolve());
		const recovery = controller.recover(async (lease) => {
			const nativeResult = await nativeFallback.promise;
			if (!lease.isCurrent() || nativeResult !== 'fallback') {
				return;
			}
			await startWorklet();
		});

		cleanup();
		nativeFallback.resolve('fallback');
		await recovery;

		expect(startWorklet).not.toHaveBeenCalled();
	});

	it('blocks a late queued attempt after final deactivation', async () => {
		const controller = createDesktopAppAudioRecoveryController();
		const cleanup = mountDesktopAppAudioRecoveryController(controller);
		const gate = createDeferred();
		const capture = mock(() => Promise.resolve());
		const active = controller.recover(async () => {
			await gate.promise;
		});
		const queued = controller.recover(async () => {
			await capture();
		});

		cleanup();
		gate.resolve();
		await Promise.all([active, queued]);

		expect(capture).not.toHaveBeenCalled();
	});
});
