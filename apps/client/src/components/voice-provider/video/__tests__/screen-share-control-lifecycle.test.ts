import { afterEach, expect, it, mock } from 'bun:test';
import type { AppData, Producer } from 'mediasoup-client/types';
import {
	createCapture,
	createProducer,
	createVideoFixture,
	deferred,
	flush,
} from '../../__tests__/video-controller-fixture';
import { settleSupersededScreenShareStart } from '../screen-share-control-lifecycle';
import { createScreenShareController, mountScreenShareController } from '../screen-share-controller';

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});
const fixture = () => {
	const f = createVideoFixture();
	const audioCompletion = deferred<'none'>();
	const audio = {
		stop: async () => {},
		awaitTeardown: async () => {},
		adoptDisplayAudio: () => {},
		discardDisplayAudio: () => {},
		start: () => audioCompletion.promise,
	};
	const c = createScreenShareController({
		...f.deps,
		shareAudio: audio,
		getDesktopBridge: () => undefined,
		requestSelection: async () => null,
		warning: () => {},
		now: () => 0,
		setInterval: (handler, ms) => {
			const timer = setInterval(handler, ms);
			timer.unref();
			return timer;
		},
		clearInterval,
	});
	disposers.push(mountScreenShareController(c));
	let starting = true;
	const restoreStage = mock(() => {
		starting = false;
	});
	const finishStart = mock(() => {
		starting = false;
	});
	const settle = () =>
		settleSupersededScreenShareStart({ isCurrent: () => true, isCaptureLive: c.isLive, finishStart, restoreStage });
	return { ...f, c, audioCompletion, settle, restoreStage, finishStart, isStarting: () => starting };
};

it('clears starting UI after terminal stop during deferred acquisition, allowing another share', async () => {
	const f = fixture();
	const pending = deferred<MediaStream>();
	const capture = createCapture();
	f.acquisitions.push(pending.promise);
	const start = f.c.start().catch(f.settle);
	await flush();
	f.c.stop();
	pending.resolve(capture.stream);
	await start;
	expect(f.isStarting()).toBe(false);
	expect(f.restoreStage).toHaveBeenCalledTimes(1);
	expect(f.finishStart).not.toHaveBeenCalled();
	expect(capture.videoTrack.readyState).toBe('ended');
	f.audioCompletion.resolve('none');
	await f.c.start();
	expect(f.c.isLive()).toBe(true);
});

for (const recovery of ['republished', 'failed republish'] as const) {
	it(`settles starting UI without releasing capture or its ended callback after ${recovery}`, async () => {
		const f = fixture();
		const ended = mock(() => {});
		const start = f.c.start(undefined, { onVideoTrackEnded: ended }).catch(f.settle);
		await flush();
		const capture = f.captures[0];
		f.c.detachProducer();
		if (recovery === 'failed republish') {
			f.publications.push(Promise.reject(new Error('republish failed')));
			await expect(f.c.republish()).rejects.toThrow('republish failed');
		} else await f.c.republish();
		f.audioCompletion.resolve('none');
		await start;
		expect(f.isStarting()).toBe(false);
		expect(f.finishStart).toHaveBeenCalledTimes(1);
		expect(f.restoreStage).not.toHaveBeenCalled();
		expect(capture?.videoTrack.readyState).toBe('live');
		capture?.end();
		expect(ended).toHaveBeenCalledTimes(1);
		expect(f.c.isLive()).toBe(false);
	});
}

it('does not settle the UI of a newer transition when an old publication completes', async () => {
	const f = fixture();
	let current = true;
	const pending = deferred<Producer<AppData>>();
	f.publications.push(pending.promise);
	const old = f.c.start().catch(() =>
		settleSupersededScreenShareStart({
			isCurrent: () => current,
			isCaptureLive: f.c.isLive,
			finishStart: f.finishStart,
			restoreStage: f.restoreStage,
		}),
	);
	await flush();
	current = false;
	f.audioCompletion.resolve('none');
	await f.c.start();
	const replacement = f.c.getStream();
	pending.resolve(createProducer('obsolete'));
	await old;
	expect(f.isStarting()).toBe(true);
	expect(f.finishStart).not.toHaveBeenCalled();
	expect(f.restoreStage).not.toHaveBeenCalled();
	expect(f.c.getStream()).toBe(replacement);
	expect(f.c.isLive()).toBe(true);
});
