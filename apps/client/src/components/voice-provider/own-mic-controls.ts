import { SoundType } from '@/features/server/types';
import type { TOwnVoiceIntent } from '@/features/server/voice/own-voice-state';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import type { TMicrophoneStartOutcome } from './microphone/microphone-pipeline-controller';

type TOwnMicControlPorts = {
	getIntent: () => TOwnVoiceIntent;
	isMicWanted: () => boolean;
	isMicMutedWithoutTest: () => boolean;
	setOwnVoiceIntent: (intent: Partial<TOwnVoiceIntent>) => void;
	cancelPushHold: () => void;
	commitMicFailure: () => void;
	getCurrentVoiceChannelId: () => number | undefined;
	hasLiveMicCapture: () => boolean;
	captureSession: () => () => boolean;
	startMicStream: () => Promise<TMicrophoneStartOutcome>;
	resetMicRecoveryBudget: () => void;
	beginOperation: () => number;
	isOperationCurrent: (token: number) => boolean;
	playSound: (sound: SoundType) => void;
	showError: (message: string) => void;
};
const createOwnMicControls = (ports: TOwnMicControlPorts) => {
	const ensureMicStarted = async (options?: { resetRecoveryBudget?: boolean }): Promise<void> => {
		const isSessionCurrent = ports.captureSession();
		const channel = ports.getCurrentVoiceChannelId();
		if (channel === undefined || !ports.isMicWanted()) return;
		if (options?.resetRecoveryBudget && !ports.hasLiveMicCapture()) ports.resetMicRecoveryBudget();
		const token = ports.hasLiveMicCapture() ? undefined : ports.beginOperation();
		const outcome = await ports.startMicStream();
		if (
			outcome.status === 'failed' &&
			token !== undefined &&
			ports.isOperationCurrent(token) &&
			isSessionCurrent() &&
			ports.getCurrentVoiceChannelId() === channel
		) {
			ports.commitMicFailure();
			ports.showError(getTrpcError(outcome.error, 'Failed to start microphone'));
		}
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
		ports.resetMicRecoveryBudget();
		if (options?.playSound !== false) ports.playSound(SoundType.OWN_USER_UNMUTED_MIC);
		await ensureMicStarted();
	};
	const toggleSound = async (options?: { forceUnmute?: boolean }) => {
		ports.beginOperation();
		const soundMuted = options?.forceUnmute ? false : !ports.getIntent().soundMuted;
		ports.setOwnVoiceIntent(options?.forceUnmute ? { soundMuted: false, micMuted: false } : { soundMuted });
		if (soundMuted) ports.cancelPushHold();
		else ports.resetMicRecoveryBudget();
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
