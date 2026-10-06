type TProducerClosedIdentity = {
	eventProducerId?: string;
	activeConsumerProducerId?: string;
	pendingProducerId?: string;
};

export const shouldIgnoreProducerClosedEvent = ({
	eventProducerId,
	activeConsumerProducerId,
	pendingProducerId,
}: TProducerClosedIdentity): boolean => {
	if (eventProducerId === undefined) {
		return false;
	}

	if (activeConsumerProducerId !== undefined && activeConsumerProducerId !== eventProducerId) {
		return true;
	}

	if (pendingProducerId !== undefined && pendingProducerId !== eventProducerId) {
		return true;
	}

	return false;
};
