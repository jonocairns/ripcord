import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWindowState, resolveWindowSizing } from '../window-state';

const MINIMUM_SIZE = { width: 1120, height: 720 };
const WORK_AREA_SIZE = { width: 1920, height: 1040 };

void describe('parseWindowState', () => {
	void it('accepts saved dimensions and ignores legacy position and maximized state', () => {
		assert.deepEqual(parseWindowState({ x: 10, y: 20, width: 1300.4, height: 800.6, isMaximized: true }), {
			width: 1300,
			height: 801,
		});
	});

	void it('rejects missing, malformed, or empty dimensions', () => {
		assert.equal(parseWindowState(undefined), undefined);
		assert.equal(parseWindowState('1300x800'), undefined);
		assert.equal(parseWindowState({ width: 1300 }), undefined);
		assert.equal(parseWindowState({ width: '1300', height: 800 }), undefined);
		assert.equal(parseWindowState({ width: 1300, height: Number.NaN }), undefined);
		assert.equal(parseWindowState({ width: 0, height: 800 }), undefined);
	});
});

void describe('resolveWindowSizing', () => {
	void it('opens at the minimum size when nothing was saved', () => {
		assert.deepEqual(resolveWindowSizing(undefined, WORK_AREA_SIZE, MINIMUM_SIZE), {
			initialSize: MINIMUM_SIZE,
			minimumSize: MINIMUM_SIZE,
		});
	});

	void it('restores saved dimensions without a position', () => {
		assert.deepEqual(resolveWindowSizing({ width: 1600, height: 1000 }, WORK_AREA_SIZE, MINIMUM_SIZE).initialSize, {
			width: 1600,
			height: 1000,
		});
	});

	void it('shrinks saved dimensions that no longer fit the primary display', () => {
		assert.deepEqual(
			resolveWindowSizing({ width: 2560, height: 1400 }, WORK_AREA_SIZE, MINIMUM_SIZE).initialSize,
			WORK_AREA_SIZE,
		);
	});

	void it('never restores below the minimum size', () => {
		assert.deepEqual(
			resolveWindowSizing({ width: 800, height: 600 }, WORK_AREA_SIZE, MINIMUM_SIZE).initialSize,
			MINIMUM_SIZE,
		);
	});

	void it('caps both the initial size and resizable minimum to a small work area', () => {
		const smallWorkArea = { width: 1024, height: 700 };

		assert.deepEqual(resolveWindowSizing({ width: 1600, height: 1000 }, smallWorkArea, MINIMUM_SIZE), {
			initialSize: smallWorkArea,
			minimumSize: smallWorkArea,
		});
	});
});
