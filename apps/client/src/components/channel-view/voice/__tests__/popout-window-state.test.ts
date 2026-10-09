import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TPopoutWindowState } from '@/runtime/types';
import { watchPopoutWindowState } from '../popout-window-state';

const WINDOW_NAME = 'ripcord-popout-screen-1';

const createBridge = () => {
	const listeners = new Set<(state: TPopoutWindowState) => void>();
	let resolveInitial: (state: TPopoutWindowState) => void = () => {};
	let rejectInitial: (error: Error) => void = () => {};
	const bridge = {
		getPopoutWindowState: () =>
			new Promise<TPopoutWindowState>((resolve, reject) => {
				resolveInitial = resolve;
				rejectInitial = reject;
			}),
		subscribePopoutWindowState: (callback: (state: TPopoutWindowState) => void) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
	};
	return {
		bridge,
		listeners,
		emit: (state: TPopoutWindowState) => {
			for (const listener of listeners) listener(state);
		},
		replyInitial: async (state: TPopoutWindowState) => {
			resolveInitial(state);
			await Promise.resolve();
		},
		failInitial: async () => {
			rejectInitial(new Error('Pop-out window is unavailable.'));
			await Promise.resolve();
		},
	};
};

const watch = (bridge: ReturnType<typeof createBridge>['bridge']) => {
	const changes: boolean[] = [];
	const stop = watchPopoutWindowState(bridge, WINDOW_NAME, (isMaximized) => changes.push(isMaximized));
	return { changes, stop };
};

void describe('popout window state', () => {
	void it('applies the initial state when no native event arrives first', async () => {
		const native = createBridge();
		const { changes } = watch(native.bridge);
		await native.replyInitial({ windowName: WINDOW_NAME, isMaximized: true });
		assert.deepEqual(changes, [true]);
	});

	void it('keeps a native event that arrives before a delayed initial reply', async () => {
		const native = createBridge();
		const { changes } = watch(native.bridge);
		native.emit({ windowName: WINDOW_NAME, isMaximized: true });
		await native.replyInitial({ windowName: WINDOW_NAME, isMaximized: false });
		assert.deepEqual(changes, [true]);
	});

	void it('ignores native events for other pop-out windows', async () => {
		const native = createBridge();
		const { changes } = watch(native.bridge);
		native.emit({ windowName: 'ripcord-popout-external-2', isMaximized: true });
		await native.replyInitial({ windowName: WINDOW_NAME, isMaximized: false });
		assert.deepEqual(changes, [false]);
	});

	void it('ignores the initial reply and later events after cleanup', async () => {
		const native = createBridge();
		const { changes, stop } = watch(native.bridge);
		stop();
		assert.equal(native.listeners.size, 0);
		await native.replyInitial({ windowName: WINDOW_NAME, isMaximized: true });
		assert.deepEqual(changes, []);
	});

	void it('tolerates the window closing before the initial reply', async () => {
		const native = createBridge();
		const { changes } = watch(native.bridge);
		await native.failInitial();
		assert.deepEqual(changes, []);
	});
});
