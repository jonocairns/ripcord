import { logVoice } from '@/helpers/browser-logger';
import { createAudioContextWithSampleRateFallback, resolveAudioContextClass } from '../audio-context';

type TMicGainPipeline = {
	audioContext: AudioContext;
	gainNode: GainNode;
	track: MediaStreamTrack;
	stream: MediaStream;
	destroy: () => Promise<void>;
};

const clampVolumePercent = (value: number) => {
	return Math.min(100, Math.max(0, value));
};

const shouldUseMicGainPipeline = (volume: number) => {
	return clampVolumePercent(volume) !== 100;
};

const createMicGainPipeline = async (
	inputStream: MediaStream,
	volume: number,
): Promise<TMicGainPipeline | undefined> => {
	const inputTrack = inputStream.getAudioTracks()[0];

	if (!inputTrack) {
		return undefined;
	}

	const AudioContextClass = resolveAudioContextClass();

	if (!AudioContextClass) {
		return undefined;
	}

	const audioContext = createAudioContextWithSampleRateFallback({
		AudioContextClass,
		sampleRate: 48_000,
		onPreferredSampleRateError: (preferredSampleRateError) => {
			logVoice('Falling back to a browser-default AudioContext for microphone gain processing', {
				preferredSampleRateError,
			});
		},
		onFallbackError: (fallbackError) => {
			logVoice('Failed to create an AudioContext for microphone gain processing', {
				fallbackError,
			});
		},
	});

	if (!audioContext) {
		return undefined;
	}

	try {
		if (audioContext.state === 'suspended') {
			await audioContext.resume();
		}
	} catch {
		// ignore resume failures and continue with the browser-managed state
	}

	const sourceNode = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
	const gainNode = audioContext.createGain();
	const destinationNode = audioContext.createMediaStreamDestination();
	const outputTrack = destinationNode.stream.getAudioTracks()[0];

	if (!outputTrack) {
		await audioContext.close().catch(() => {
			// ignore close failures
		});
		return undefined;
	}

	gainNode.gain.value = clampVolumePercent(volume) / 100;
	sourceNode.connect(gainNode);
	gainNode.connect(destinationNode);

	const handleInputEnded = () => {
		outputTrack.stop();
	};

	inputTrack.addEventListener('ended', handleInputEnded);

	return {
		audioContext,
		gainNode,
		track: outputTrack,
		stream: destinationNode.stream,
		destroy: async () => {
			inputTrack.removeEventListener('ended', handleInputEnded);
			outputTrack.stop();

			try {
				sourceNode.disconnect();
			} catch {
				// ignore disconnect failures
			}

			try {
				gainNode.disconnect();
			} catch {
				// ignore disconnect failures
			}

			try {
				destinationNode.disconnect();
			} catch {
				// ignore disconnect failures
			}

			await audioContext.close().catch(() => {
				// ignore close failures
			});
		},
	};
};

export type { TMicGainPipeline };
export { clampVolumePercent, createMicGainPipeline, shouldUseMicGainPipeline };
