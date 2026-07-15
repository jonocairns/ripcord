type TVoiceTransportPairDisposalCause =
	| 'allocation_failed'
	| 'prepared_transport_failed'
	| 'request_cleanup'
	| 'runtime_destroyed';

type TVoiceTransportPairObservationEvent =
	| { outcome: 'prepared' }
	| { outcome: 'committed' }
	| { outcome: 'disposed'; cause: TVoiceTransportPairDisposalCause };

type TVoiceTransportPairObserver = (event: TVoiceTransportPairObservationEvent) => void;

type TVoiceSessionAttemptKind = 'manual_join' | 'restore';
type TVoiceSessionAttemptPath = 'fresh' | 'existing' | 'same_channel_replacement' | 'cross_channel_replacement';
type TVoiceSessionAttemptOutcome =
	| 'succeeded'
	| 'cancelled'
	| 'superseded'
	| 'conflict'
	| 'preparation_failed'
	| 'precommit_failed'
	| 'postcommit_membership_failed'
	| 'postcommit_binding_failed'
	| 'postcommit_presence_failed'
	| 'postcommit_response_failed';

type TVoiceSessionAttemptObservation = {
	pairObserver: TVoiceTransportPairObserver;
	finish: (result: { path: TVoiceSessionAttemptPath; outcome: TVoiceSessionAttemptOutcome; error?: unknown }) => void;
};

type TVoiceSessionObserver = {
	startAttempt: (context: {
		kind: TVoiceSessionAttemptKind;
		reconnectAttemptId?: string;
		hasClientInstanceId: boolean;
	}) => TVoiceSessionAttemptObservation;
};

const noOpVoiceSessionAttemptObservation: TVoiceSessionAttemptObservation = {
	pairObserver: () => {},
	finish: () => {},
};

const startVoiceSessionAttemptObservation = (
	observer: TVoiceSessionObserver | undefined,
	context: Parameters<TVoiceSessionObserver['startAttempt']>[0],
): TVoiceSessionAttemptObservation => {
	try {
		return observer?.startAttempt(context) ?? noOpVoiceSessionAttemptObservation;
	} catch {
		return noOpVoiceSessionAttemptObservation;
	}
};

const finishVoiceSessionAttemptObservation = (
	observation: TVoiceSessionAttemptObservation,
	result: Parameters<TVoiceSessionAttemptObservation['finish']>[0],
): void => {
	try {
		observation.finish(result);
	} catch {
		// Telemetry is never a voice-session correctness dependency.
	}
};

export type {
	TVoiceSessionAttemptKind,
	TVoiceSessionAttemptObservation,
	TVoiceSessionAttemptOutcome,
	TVoiceSessionAttemptPath,
	TVoiceSessionObserver,
	TVoiceTransportPairDisposalCause,
	TVoiceTransportPairObservationEvent,
	TVoiceTransportPairObserver,
};
export {
	finishVoiceSessionAttemptObservation,
	noOpVoiceSessionAttemptObservation,
	startVoiceSessionAttemptObservation,
};
