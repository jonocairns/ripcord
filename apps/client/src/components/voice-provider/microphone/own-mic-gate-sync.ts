const mountOwnMicGateSync = (ports: {
	isTransmitting: () => boolean;
	subscribe: (listener: () => void) => () => void;
	apply: (muted: boolean) => void;
}) => {
	let previous = ports.isTransmitting();
	return ports.subscribe(() => {
		const next = ports.isTransmitting();
		if (previous === next) return;
		previous = next;
		ports.apply(!next);
	});
};

export { mountOwnMicGateSync };
