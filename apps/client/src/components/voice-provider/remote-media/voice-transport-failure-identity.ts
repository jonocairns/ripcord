import type { TVoiceTransportFailureEvent } from '@sharkord/shared';

type TCurrentVoiceTransportIds = {
	producerTransportId: string | undefined;
	consumerTransportId: string | undefined;
};

const shouldHandleVoiceTransportFailure = (
	failure: TVoiceTransportFailureEvent,
	current: TCurrentVoiceTransportIds,
): boolean => {
	if (failure.transportId === undefined) {
		// Older servers send identity-less failures. Keep supporting them and let
		// the generation-scoped recovery circuit provide the safety bound.
		return true;
	}

	if (failure.source === 'producer-dtls') {
		return failure.transportId === current.producerTransportId;
	}

	if (failure.source === 'consumer-dtls' || failure.source === 'media-liveness') {
		return failure.transportId === current.consumerTransportId;
	}

	// A future/older mixed-version server may supply identity before source.
	return failure.transportId === current.producerTransportId || failure.transportId === current.consumerTransportId;
};

export type { TCurrentVoiceTransportIds };
export { shouldHandleVoiceTransportFailure };
