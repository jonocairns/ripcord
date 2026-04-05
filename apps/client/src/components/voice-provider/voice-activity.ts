import {
	acquireSharedVoiceAudioContext,
	releaseSharedVoiceAudioContext,
} from '@/components/voice-provider/shared-audio-context';

export type VoiceActivity = {
	audioLevel: number;
	isSpeaking: boolean;
};

export type VoiceActivityStore = {
	subscribe: (listener: () => void) => () => void;
	getUserActivity: (userId: number) => VoiceActivity;
	setUserActivity: (userId: number, activity: VoiceActivity) => void;
	clearUserActivity: (userId: number) => void;
	clearAll: () => void;
};

const ANALYZER_FFT_SIZE = 512;
const ANALYZER_MIN_DECIBELS = -90;
const ANALYZER_MAX_DECIBELS = -10;
const ANALYZER_SMOOTHING_TIME_CONSTANT = 0.85;
const SPEAKING_THRESHOLD = 8;
const AUDIO_LEVEL_POLL_INTERVAL_MS = 50;
const AUDIO_LEVEL_PRECISION = 1;

const EMPTY_VOICE_ACTIVITY: VoiceActivity = {
	audioLevel: 0,
	isSpeaking: false,
};

const createVoiceActivityStore = (): VoiceActivityStore => {
	const listeners = new Set<() => void>();
	const activities = new Map<number, VoiceActivity>();

	const emit = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};

	return {
		subscribe: (listener) => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
		getUserActivity: (userId) => {
			return activities.get(userId) ?? EMPTY_VOICE_ACTIVITY;
		},
		setUserActivity: (userId, activity) => {
			const previous = activities.get(userId);

			if (previous?.audioLevel === activity.audioLevel && previous.isSpeaking === activity.isSpeaking) {
				return;
			}

			activities.set(userId, activity);
			emit();
		},
		clearUserActivity: (userId) => {
			if (!activities.has(userId)) {
				return;
			}

			activities.delete(userId);
			emit();
		},
		clearAll: () => {
			if (activities.size === 0) {
				return;
			}

			activities.clear();
			emit();
		},
	};
};

const startVoiceActivityMonitor = (
	audioStream: MediaStream,
	onUpdate: (activity: VoiceActivity) => void,
): (() => void) => {
	onUpdate(EMPTY_VOICE_ACTIVITY);

	const audioContext = acquireSharedVoiceAudioContext();

	if (!audioContext) {
		return () => undefined;
	}

	let cancelled = false;
	let timeoutId: number | null = null;
	let sourceNode: MediaStreamAudioSourceNode | null = null;
	let analyserNode: AnalyserNode | null = null;
	const clonedStream = audioStream.clone();
	let previousActivity = EMPTY_VOICE_ACTIVITY;

	const startAnalyser = () => {
		if (cancelled) {
			return;
		}

		try {
			const analyser = audioContext.createAnalyser();
			const source = audioContext.createMediaStreamSource(clonedStream);

			analyser.fftSize = ANALYZER_FFT_SIZE;
			analyser.minDecibels = ANALYZER_MIN_DECIBELS;
			analyser.maxDecibels = ANALYZER_MAX_DECIBELS;
			analyser.smoothingTimeConstant = ANALYZER_SMOOTHING_TIME_CONSTANT;

			source.connect(analyser);

			sourceNode = source;
			analyserNode = analyser;

			const dataArray = new Uint8Array(analyser.frequencyBinCount);

			const checkAudioLevel = () => {
				if (cancelled || !analyserNode) {
					return;
				}

				analyserNode.getByteFrequencyData(dataArray);

				let sum = 0;

				for (let index = 0; index < dataArray.length; index += 1) {
					sum += dataArray[index] * dataArray[index];
				}

				const rms = Math.sqrt(sum / dataArray.length);
				const normalizedLevel = Math.min(100, (rms / 255) * 100);
				const roundedLevel = Math.round(normalizedLevel / AUDIO_LEVEL_PRECISION) * AUDIO_LEVEL_PRECISION;
				const nextActivity = {
					audioLevel: roundedLevel,
					isSpeaking: roundedLevel > SPEAKING_THRESHOLD,
				};

				if (
					nextActivity.audioLevel !== previousActivity.audioLevel ||
					nextActivity.isSpeaking !== previousActivity.isSpeaking
				) {
					previousActivity = nextActivity;
					onUpdate(nextActivity);
				}

				timeoutId = window.setTimeout(checkAudioLevel, AUDIO_LEVEL_POLL_INTERVAL_MS);
			};

			checkAudioLevel();
		} catch (error) {
			console.warn('Audio level detection not supported:', error);
		}
	};

	if (audioContext.state === 'suspended') {
		void audioContext.resume().then(startAnalyser, () => {
			console.warn('AudioContext resume failed — audio levels unavailable');
		});
	} else {
		startAnalyser();
	}

	return () => {
		cancelled = true;

		if (timeoutId !== null) {
			window.clearTimeout(timeoutId);
			timeoutId = null;
		}

		if (sourceNode) {
			sourceNode.disconnect();
			sourceNode = null;
		}

		if (analyserNode) {
			analyserNode.disconnect();
			analyserNode = null;
		}

		clonedStream.getTracks().forEach((track) => {
			track.stop();
		});
		releaseSharedVoiceAudioContext(audioContext);
		onUpdate(EMPTY_VOICE_ACTIVITY);
	};
};

export { createVoiceActivityStore, EMPTY_VOICE_ACTIVITY, startVoiceActivityMonitor };
