import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPopoutControlsVisibility } from '../popout-controls-visibility';

const createVisibility = () => {
	const pending = new Set<() => void>();
	const changes: boolean[] = [];
	let interacting = false;
	const visibility = createPopoutControlsVisibility({
		setVisible: (visible) => changes.push(visible),
		isInteracting: () => interacting,
		scheduleHide: (callback) => {
			pending.add(callback);
			return () => pending.delete(callback);
		},
	});
	return {
		...visibility,
		pending,
		changes,
		setInteracting: (value: boolean) => {
			interacting = value;
		},
		expireIdleTimer: () => {
			const callbacks = Array.from(pending);
			pending.clear();
			for (const callback of callbacks) callback();
		},
	};
};

void describe('popout controls visibility', () => {
	void it('reveals controls on activity and hides them after inactivity', () => {
		const visibility = createVisibility();
		visibility.reveal();
		assert.deepEqual(visibility.changes, [true]);
		visibility.expireIdleTimer();
		assert.deepEqual(visibility.changes, [true, false]);
	});

	void it('extends the idle interval on new activity instead of leaving old hide timers active', () => {
		const visibility = createVisibility();
		visibility.reveal();
		visibility.reveal();
		assert.equal(visibility.pending.size, 1);
		assert.equal(visibility.changes.includes(false), false);
		visibility.expireIdleTimer();
		assert.deepEqual(visibility.changes, [true, true, false]);
	});

	void it('keeps controls visible during hover or keyboard interaction and hides after leaving', () => {
		const visibility = createVisibility();
		visibility.reveal();
		visibility.setInteracting(true);
		visibility.expireIdleTimer();
		assert.deepEqual(visibility.changes, [true]);
		visibility.setInteracting(false);
		visibility.reveal();
		assert.deepEqual(visibility.changes, [true, true]);
		visibility.expireIdleTimer();
		assert.deepEqual(visibility.changes, [true, true, false]);
	});

	void it('cancels timers and ignores late activity or timer callbacks after the popout unmounts', () => {
		const visibility = createVisibility();
		visibility.reveal();
		const callbacks = Array.from(visibility.pending);
		visibility.dispose();
		assert.equal(visibility.pending.size, 0);
		visibility.reveal();
		for (const callback of callbacks) callback();
		assert.deepEqual(visibility.changes, [true]);
	});
});
