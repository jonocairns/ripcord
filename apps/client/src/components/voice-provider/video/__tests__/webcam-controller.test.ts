import { afterEach, describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer } from 'mediasoup-client/types';
import { createProducer, createVideoFixture, deferred, flush } from '../../__tests__/video-controller-fixture';
import { createWebcamController, didWebcamCaptureSettingsChange, mountWebcamController } from '../webcam-controller';

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});
const createMountedWebcam = (...args: Parameters<typeof createWebcamController>) => {
	const controller = createWebcamController(...args);
	disposers.push(mountWebcamController(controller));
	return controller;
};
describe('webcam production owner', () => {
	it('acquires only on start, publishes configured video and stops the current capture before clearing its snapshot', async () => {
		const f = createVideoFixture();
		const c = createMountedWebcam(f.deps);
		const unmount = mountWebcamController(c);
		expect(f.acquire).not.toHaveBeenCalled();
		await c.start();
		const capture = f.captures[0];
		expect(capture).toBeDefined();
		expect(f.produce.mock.calls[0]?.[0]).toMatchObject({ stopTracks: false, appData: { kind: StreamKind.VIDEO } });
		c.stop();
		expect(capture?.videoTrack.readyState).toBe('ended');
		expect(c.getStream()).toBeUndefined();
		expect(c.getProducer()).toBeUndefined();
		expect(f.closeProducer).toHaveBeenCalledWith('producer-0');
		unmount();
	});
	it('detaches and republishes without reacquiring or stopping capture', async () => {
		const f = createVideoFixture();
		const c = createMountedWebcam(f.deps);
		await c.start();
		const capture = f.captures[0];
		c.detachProducer();
		expect(capture?.videoTrack.readyState).toBe('live');
		await c.republish();
		expect(f.acquire).toHaveBeenCalledTimes(1);
		expect(c.getProducer()?.id).toBe('producer-1');
		c.stop();
	});
	it('preserves surviving capture after failed republish', async () => {
		const f = createVideoFixture();
		const c = createMountedWebcam(f.deps);
		await c.start();
		c.detachProducer();
		f.publications.push(Promise.reject(new Error('publish failed')));
		await expect(c.republish()).rejects.toThrow('publish failed');
		expect(c.getStream()).toBe(f.captures[0]?.stream);
		expect(f.captures[0]?.videoTrack.readyState).toBe('live');
		c.stop();
	});
	it('rejects transport replacement across awaited publication', async () => {
		const f = createVideoFixture();
		const c = createMountedWebcam(f.deps);
		const pending = deferred<Producer<AppData>>();
		f.publications.push(pending.promise);
		const start = c.start();
		await flush();
		f.replaceTransport();
		const producer = createProducer('late');
		pending.resolve(producer);
		await expect(start).rejects.toThrow();
		expect(producer.closed).toBe(true);
		expect(c.getProducer()).toBeUndefined();
		c.stop();
	});
	it('stops on lifecycle cleanup and keeps track-ended notification through republishing', async () => {
		const f = createVideoFixture();
		const c = createMountedWebcam(f.deps);
		const unmount = mountWebcamController(c);
		await c.start();
		c.detachProducer();
		await c.republish();
		f.captures[0]?.end();
		expect(f.onTrackEnded).toHaveBeenCalledTimes(1);
		expect(c.getStream()).toBeUndefined();
		unmount();
	});
	it('restarts for camera constraints and codec changes, while ignoring unrelated device settings', async () => {
		const f = createVideoFixture();
		const c = createMountedWebcam(f.deps);
		await c.start();
		const previous = f.getDevices();
		const next = { ...previous, webcamFramerate: 60, webcamId: 'camera-b' };
		expect(didWebcamCaptureSettingsChange(previous, next)).toBe(true);
		expect(didWebcamCaptureSettingsChange(previous, { ...previous, microphoneId: 'mic-b' })).toBe(false);
		f.setDevices(next);
		await c.restart();
		expect(f.captures[0]?.videoTrack.readyState).toBe('ended');
		expect(f.acquire.mock.calls[1]?.[0]).toMatchObject({
			audio: false,
			video: { frameRate: 60, deviceId: { exact: 'camera-b' } },
		});
		c.stop();
	});
});
