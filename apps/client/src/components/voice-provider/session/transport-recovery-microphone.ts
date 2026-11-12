import type { TMicrophoneStartOutcome } from '../microphone/microphone-pipeline-controller';
import { MicPipelineSupersededError } from '../microphone/microphone-pipeline-controller';

type TTransportRecoveryMicrophoneAction = 'skip' | 'publish-current' | 'start';

type TResolveTransportRecoveryMicrophoneActionInput = {
	recoveryJoined: boolean;
	micMuted: boolean;
	canSpeak: boolean;
	hasCurrentStream: boolean;
	currentTrackLive: boolean;
	canStart: boolean;
};

type TTransportRecoveryMicrophoneResult =
	| 'skipped'
	| 'published-current'
	| 'started'
	| 'continued-muted'
	| 'superseded';

type TRecoverTransportMicrophonePorts = {
	start: (() => Promise<TMicrophoneStartOutcome>) | undefined;
	publishCurrent: () => Promise<void>;
	discardCurrent: () => Promise<void>;
	onStartFailed: (error: unknown) => void;
};

const resolveTransportRecoveryMicrophoneAction = ({
	recoveryJoined,
	micMuted,
	canSpeak,
	hasCurrentStream,
	currentTrackLive,
	canStart,
}: TResolveTransportRecoveryMicrophoneActionInput): TTransportRecoveryMicrophoneAction => {
	if (recoveryJoined && !micMuted && canSpeak && canStart) {
		return 'start';
	}

	if (hasCurrentStream && currentTrackLive) {
		return 'publish-current';
	}

	if (!micMuted && canSpeak && canStart) {
		return 'start';
	}

	return 'skip';
};

const recoverTransportMicrophone = async (
	input: Omit<TResolveTransportRecoveryMicrophoneActionInput, 'canStart'>,
	ports: TRecoverTransportMicrophonePorts,
): Promise<TTransportRecoveryMicrophoneResult> => {
	const start = ports.start;
	const action = resolveTransportRecoveryMicrophoneAction({
		...input,
		canStart: start !== undefined,
	});

	if (action === 'skip') {
		return 'skipped';
	}

	if (action === 'publish-current') {
		try {
			await ports.publishCurrent();
			return 'published-current';
		} catch (error) {
			if (error instanceof MicPipelineSupersededError) return 'superseded';
			await ports.discardCurrent();
			ports.onStartFailed(error);
			return 'continued-muted';
		}
	}

	if (start === undefined) {
		return 'skipped';
	}

	const outcome = await start();
	if (outcome.status === 'failed') {
		ports.onStartFailed(outcome.error);
		return 'continued-muted';
	}

	return outcome.status;
};

export type { TTransportRecoveryMicrophoneResult };
export { recoverTransportMicrophone, resolveTransportRecoveryMicrophoneAction };
