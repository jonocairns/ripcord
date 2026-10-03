import type { TDeviceSettings } from '@/types';
import { VoiceSessionExecutionSupersededError } from './hooks/session-execution-ownership';
import { didMicCaptureSettingsChange } from './mic-capture-config';
import type { TMicrophoneStartOutcome } from './microphone-pipeline-controller';
import { didWebcamCaptureSettingsChange } from './webcam-controller';

type TMediaSettingsInputs = {
	devices: TDeviceSettings;
	currentVoiceChannelId: number | undefined;
	webcamEnabled: boolean;
};
type TMediaSettingsDependencies = {
	getInputs: () => TMediaSettingsInputs;
	subscribeInputs: (listener: () => void) => () => void;
	startMicrophone: () => Promise<TMicrophoneStartOutcome>;
	restartWebcam: () => Promise<void>;
	log: (message: string, data?: Record<string, unknown>) => void;
	error: (message: string) => void;
};

// Each notification starts its own invocation, just as the original effect did.
// Preserve mic-before-webcam ordering without serializing or cancelling overlaps.
const mountMediaSettingsIntegration = (deps: TMediaSettingsDependencies): (() => void) => {
	let previousDevices: TDeviceSettings | undefined;
	const apply = () => {
		const { devices, currentVoiceChannelId, webcamEnabled } = deps.getInputs();
		const previous = previousDevices;
		previousDevices = devices;
		if (!previous || currentVoiceChannelId === undefined) return;
		const shouldRestartMic = didMicCaptureSettingsChange(previous, devices);
		const shouldRestartWebcam = webcamEnabled && didWebcamCaptureSettingsChange(previous, devices);
		if (!shouldRestartMic && !shouldRestartWebcam) return;
		void (async () => {
			if (shouldRestartMic) {
				deps.log('Applying updated microphone settings live');
				const outcome = await deps.startMicrophone();
				if (outcome.status === 'failed') {
					deps.log('Failed to apply microphone settings live', { error: outcome.error });
					deps.error('Failed to apply microphone settings');
				}
			}
			if (shouldRestartWebcam) {
				try {
					deps.log('Applying updated webcam settings live');
					await deps.restartWebcam();
				} catch (error) {
					if (error instanceof VoiceSessionExecutionSupersededError) return;
					deps.log('Failed to apply webcam settings live', { error });
					deps.error('Failed to apply webcam settings');
				}
			}
		})();
	};
	apply();
	return deps.subscribeInputs(apply);
};

export { mountMediaSettingsIntegration, type TMediaSettingsDependencies, type TMediaSettingsInputs };
