import { SoundType } from '@/features/server/types';
import type { TOwnVoiceIntent } from '@/features/server/voice/own-voice-state';
import type { TMicrophoneStartOutcome } from './microphone/microphone-pipeline-controller';

type TOwnMicControlPorts = {
	getIntent: () => TOwnVoiceIntent;
	isMicWanted: () => boolean;
	isMicMutedWithoutTest: () => boolean;
	setOwnVoiceIntent: (intent: Partial<TOwnVoiceIntent>) => void;
	cancelPushHold: () => void;
	getCurrentVoiceChannelId: () => number | undefined;
	hasLiveMicCapture: () => boolean;
	startMicStream: () => Promise<TMicrophoneStartOutcome>;
	resetMicRecoveryBudget: () => void;
	beginOperation: () => number;
	playSound: (sound: SoundType) => void;
};
const createOwnMicControls = (ports: TOwnMicControlPorts) => {
	const ensureMicStarted = async (options?: { resetRecoveryBudget?: boolean }): Promise<void> => {
		const channel = ports.getCurrentVoiceChannelId();
		if (channel === undefined || !ports.isMicWanted()) return;
		if (options?.resetRecoveryBudget && !ports.hasLiveMicCapture()) ports.resetMicRecoveryBudget();
		await ports.startMicStream();
	};
	const setMicMuted = async (next: boolean, options?: { playSound?: boolean }) => {
		const intent = ports.getIntent();
		if (intent.soundMuted) return;
		if (next) {
			ports.beginOperation();
			ports.setOwnVoiceIntent({ micMuted: true });
			ports.cancelPushHold();
			if (!intent.micMuted && options?.playSound !== false) ports.playSound(SoundType.OWN_USER_MUTED_MIC);
			return;
		}
		if (!intent.micMuted) return;
		ports.beginOperation();
		ports.setOwnVoiceIntent({ micMuted: false });
		if (!ports.hasLiveMicCapture()) ports.resetMicRecoveryBudget();
		if (options?.playSound !== false) ports.playSound(SoundType.OWN_USER_UNMUTED_MIC);
		await ensureMicStarted();
	};
	const toggleSound = async (options?: { forceUnmute?: boolean }) => {
		ports.beginOperation();
		const soundMuted = options?.forceUnmute ? false : !ports.getIntent().soundMuted;
		ports.setOwnVoiceIntent(options?.forceUnmute ? { soundMuted: false, micMuted: false } : { soundMuted });
		if (soundMuted) ports.cancelPushHold();
		else if (!ports.hasLiveMicCapture()) ports.resetMicRecoveryBudget();
		ports.playSound(soundMuted ? SoundType.OWN_USER_MUTED_SOUND : SoundType.OWN_USER_UNMUTED_SOUND);
		await ensureMicStarted();
	};
	const toggleMic = () =>
		ports.getIntent().soundMuted
			? toggleSound({ forceUnmute: true })
			: setMicMuted(!ports.isMicMutedWithoutTest(), { playSound: true });
	return { ensureMicStarted, setMicMuted, toggleSound, toggleMic };
};

export { createOwnMicControls, type TOwnMicControlPorts };
