import { describe, expect, it, mock } from 'bun:test';
import { DEFAULT_DEVICE_SETTINGS } from '../../devices-provider/migrate-device-settings';
import { mountMediaSettingsIntegration, type TMediaSettingsInputs } from '../media-settings-integration';
import type { TMicrophoneStartOutcome } from '../microphone-pipeline-controller';
import { createWebcamController, mountWebcamController } from '../webcam-controller';
import { createCapture, createVideoFixture, deferred, flush } from './video-controller-fixture';

const fixture = () => {
	let inputs: TMediaSettingsInputs = {
		devices: { ...DEFAULT_DEVICE_SETTINGS },
		currentVoiceChannelId: 1,
		webcamEnabled: true,
	};
	let listener: (() => void) | undefined;
	const events: string[] = [];
	const micResults: Array<Promise<TMicrophoneStartOutcome>> = [];
	const webcamResults: Array<Promise<void>> = [];
	const startMicrophone = mock(async (): Promise<TMicrophoneStartOutcome> => {
		events.push('mic');
		return micResults.shift() ?? { status: 'started' };
	});
	const restartWebcam = mock(async () => {
		events.push('webcam');
		await webcamResults.shift();
	});
	const error = mock((_message: string) => {});
	const dispose = mountMediaSettingsIntegration({
		getInputs: () => inputs,
		subscribeInputs: (cb) => {
			listener = cb;
			return () => {
				listener = undefined;
			};
		},
		startMicrophone,
		restartWebcam,
		error,
		log: () => {},
	});
	const update = (next: TMediaSettingsInputs) => {
		inputs = next;
		listener?.();
	};
	const changeBoth = () =>
		update({
			...inputs,
			devices: {
				...inputs.devices,
				microphoneId: `${inputs.devices.microphoneId}-new`,
				webcamId: `${inputs.devices.webcamId}-new`,
			},
		});
	return {
		events,
		micResults,
		webcamResults,
		startMicrophone,
		restartWebcam,
		error,
		dispose,
		update,
		changeBoth,
		getInputs: () => inputs,
	};
};
describe('media settings production integration mount', () => {
	it('does no initial acquisition and orders mic before webcam within an invocation', async () => {
		const f = fixture();
		expect(f.events).toEqual([]);
		const pending = deferred<TMicrophoneStartOutcome>();
		f.micResults.push(pending.promise);
		f.changeBoth();
		await flush();
		expect(f.events).toEqual(['mic']);
		pending.resolve({ status: 'started' });
		await flush();
		expect(f.events).toEqual(['mic', 'webcam']);
		f.dispose();
	});
	it('continues to webcam after microphone failure and reports both failures', async () => {
		const f = fixture();
		f.micResults.push(Promise.resolve({ status: 'failed', error: new Error('mic failed') }));
		const webcam = deferred<void>();
		f.webcamResults.push(webcam.promise);
		f.changeBoth();
		await flush();
		webcam.reject(new Error('webcam failed'));
		await flush();
		expect(f.events).toEqual(['mic', 'webcam']);
		expect(f.error.mock.calls.map(([message]) => message)).toEqual([
			'Failed to apply microphone settings',
			'Failed to apply webcam settings',
		]);
		f.dispose();
	});
	it('advances the comparison baseline while outside voice, without restarting on later join', async () => {
		const f = fixture();
		f.update({ ...f.getInputs(), currentVoiceChannelId: undefined });
		f.changeBoth();
		await flush();
		f.update({ ...f.getInputs(), currentVoiceChannelId: 2 });
		await flush();
		expect(f.events).toEqual([]);
		f.dispose();
	});
	it('does not restart a disabled webcam or restart media for unrelated settings', async () => {
		const f = fixture();
		f.update({ ...f.getInputs(), webcamEnabled: false });
		f.changeBoth();
		await flush();
		expect(f.events).toEqual(['mic']);
		f.update({ ...f.getInputs(), devices: { ...f.getInputs().devices, nativeAppAudioIngestEnabled: true } });
		await flush();
		expect(f.events).toEqual(['mic']);
		f.dispose();
	});
	it('restarts only webcam for camera changes', async () => {
		const f = fixture();
		f.update({ ...f.getInputs(), devices: { ...f.getInputs().devices, webcamFramerate: 60 } });
		await flush();
		expect(f.events).toEqual(['webcam']);
		f.dispose();
	});
	it('preserves independent overlapping invocations and their individual mic-before-webcam order', async () => {
		const f = fixture();
		const first = deferred<TMicrophoneStartOutcome>();
		const second = deferred<TMicrophoneStartOutcome>();
		f.micResults.push(first.promise, second.promise);
		f.changeBoth();
		f.changeBoth();
		await flush();
		expect(f.events).toEqual(['mic', 'mic']);
		second.resolve({ status: 'started' });
		await flush();
		expect(f.events).toEqual(['mic', 'mic', 'webcam']);
		first.resolve({ status: 'started' });
		await flush();
		expect(f.events).toEqual(['mic', 'mic', 'webcam', 'webcam']);
		f.dispose();
	});
	it('unsubscribes on cleanup and preserves the existing uncancelled in-flight invocation', async () => {
		const f = fixture();
		const pending = deferred<TMicrophoneStartOutcome>();
		f.micResults.push(pending.promise);
		f.changeBoth();
		f.dispose();
		f.changeBoth();
		pending.resolve({ status: 'started' });
		await flush();
		expect(f.events).toEqual(['mic', 'webcam']);
	});
});

it('uses the production webcam owner to reject stale overlapping settings restart completion', async () => {
	const f = createVideoFixture();
	const webcam = createWebcamController(f.deps);
	const disposeWebcam = mountWebcamController(webcam);
	await webcam.start();
	let notify = () => {};
	const events: string[] = [];
	const error = mock((_message: string) => {});
	const disposeSettings = mountMediaSettingsIntegration({
		getInputs: () => ({ devices: f.getDevices(), currentVoiceChannelId: 1, webcamEnabled: true }),
		subscribeInputs: (listener) => {
			notify = listener;
			return () => {
				notify = () => {};
			};
		},
		startMicrophone: async () => {
			events.push('mic');
			return { status: 'started' };
		},
		restartWebcam: () => {
			events.push('webcam');
			return webcam.restart();
		},
		log: () => {},
		error,
	});
	const old = createCapture();
	const pending = deferred<MediaStream>();
	f.acquisitions.push(pending.promise);
	f.setDevices({ ...f.getDevices(), microphoneId: 'mic-b', webcamId: 'camera-b' });
	notify();
	await flush();
	f.setDevices({ ...f.getDevices(), microphoneId: 'mic-c', webcamId: 'camera-c' });
	notify();
	await flush();
	const replacement = webcam.getStream();
	pending.resolve(old.stream);
	await flush();
	expect(events).toEqual(['mic', 'webcam', 'mic', 'webcam']);
	expect(webcam.getStream()).toBe(replacement);
	expect(webcam.isLive()).toBe(true);
	expect(old.videoTrack.readyState).toBe('ended');
	expect(error).not.toHaveBeenCalled();
	disposeSettings();
	disposeWebcam();
});
