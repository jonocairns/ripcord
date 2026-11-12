// Detach synchronously; drain unfinished setup before a successor acquires capture.
const createMicTestRunOwner = (ports: { detach: () => Promise<void>; setActive: (active: boolean) => void }) => {
	let generation = 0;
	let draining = Promise.resolve();
	const track = <T>(promise: Promise<T>): Promise<T> => {
		draining = Promise.all([draining, promise]).then(
			() => {},
			() => {},
		);
		return promise;
	};
	const detach = () => track(ports.detach());
	const stop = () => {
		generation += 1;
		const result = detach();
		ports.setActive(false);
		return result;
	};
	const begin = () => {
		const token = (generation += 1);
		const ready = Promise.all([draining, detach()]).then(() => {});
		const isCurrent = () => generation === token;
		return {
			ready,
			isCurrent,
			track,
			activate: () => {
				if (isCurrent()) ports.setActive(true);
			},
			fail: () => (isCurrent() ? stop() : Promise.resolve()),
		};
	};
	return { begin, stop };
};

export { createMicTestRunOwner };
