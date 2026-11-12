// Resource detachment is synchronous; asynchronous graph/recording destruction
// drains before another run can activate. Failure callbacks carry their run.
const createMicTestRunOwner = (ports: { detach: () => Promise<void>; setActive: (active: boolean) => void }) => {
	let generation = 0;
	let draining = Promise.resolve();
	const detach = () => {
		const ownDrain = ports.detach();
		ports.setActive(false);
		draining = Promise.all([draining, ownDrain]).then(() => {});
		return draining;
	};
	const stop = () => {
		generation += 1;
		return detach();
	};
	const begin = () => {
		const token = (generation += 1);
		const ready = detach();
		const isCurrent = () => generation === token;
		return {
			ready,
			isCurrent,
			activate: () => {
				if (isCurrent()) ports.setActive(true);
			},
			fail: () => (isCurrent() ? stop() : Promise.resolve()),
		};
	};
	return { begin, stop };
};

export { createMicTestRunOwner };
