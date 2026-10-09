import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	controlPopoutWindow,
	getPopoutWindowState,
	isMediaPopoutWindowName,
	type TMediaPopoutWindow,
} from '../media-popout-windows';

const createWindow = (options: { destroyed?: boolean; maximized?: boolean } = {}) => {
	const actions: string[] = [];
	const window: TMediaPopoutWindow = {
		isDestroyed: () => options.destroyed ?? false,
		isMaximized: () => options.maximized ?? false,
		minimize: () => actions.push('minimize'),
		maximize: () => actions.push('maximize'),
		unmaximize: () => actions.push('unmaximize'),
	};
	return { window, actions };
};

void describe('media popout windows', () => {
	void it('reads the current native maximized state of the named window', () => {
		const options = { maximized: false };
		const popout = createWindow(options);
		const windows = new Map([['screen-share-1', popout.window]]);
		assert.deepEqual(getPopoutWindowState(windows, 'screen-share-1'), {
			windowName: 'screen-share-1',
			isMaximized: false,
		});
		options.maximized = true;
		assert.equal(getPopoutWindowState(windows, 'screen-share-1').isMaximized, true);
		assert.throws(() => getPopoutWindowState(windows, 'missing'), /no longer available/);
	});
	void it('identifies both media popout kinds without including unrelated windows', () => {
		assert.equal(isMediaPopoutWindowName('screen-share-42'), true);
		assert.equal(isMediaPopoutWindowName('external-stream-plugin-camera'), true);
		for (const name of ['', 'main', 'screen-share-', 'external-stream-', 'oauth-popup']) {
			assert.equal(isMediaPopoutWindowName(name), false);
		}
	});

	void it('controls only the named popout when several windows are open', () => {
		const first = createWindow();
		const second = createWindow();
		const windows = new Map([
			['screen-share-1', first.window],
			['screen-share-2', second.window],
		]);
		controlPopoutWindow(windows, 'screen-share-2', 'minimize');
		assert.deepEqual(first.actions, []);
		assert.deepEqual(second.actions, ['minimize']);
	});

	void it('restores a maximized popout and maximizes a normal popout', () => {
		const normal = createWindow();
		const maximized = createWindow({ maximized: true });
		const windows = new Map([
			['screen-share-1', normal.window],
			['screen-share-2', maximized.window],
		]);
		controlPopoutWindow(windows, 'screen-share-1', 'toggle-maximize');
		controlPopoutWindow(windows, 'screen-share-2', 'toggle-maximize');
		assert.deepEqual(normal.actions, ['maximize']);
		assert.deepEqual(maximized.actions, ['unmaximize']);
	});

	void it('rejects unknown and closed windows without falling back to another window', () => {
		const open = createWindow();
		const closed = createWindow({ destroyed: true });
		const windows = new Map([
			['screen-share-1', open.window],
			['screen-share-2', closed.window],
		]);
		assert.throws(() => controlPopoutWindow(windows, 'main', 'minimize'), /no longer available/);
		assert.throws(() => controlPopoutWindow(windows, 'screen-share-2', 'toggle-maximize'), /no longer available/);
		assert.throws(() => getPopoutWindowState(windows, 'screen-share-2'), /no longer available/);
		assert.deepEqual(open.actions, []);
		assert.deepEqual(closed.actions, []);
	});
});
