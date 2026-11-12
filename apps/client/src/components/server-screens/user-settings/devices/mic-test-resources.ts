// A run registers each resource at acquisition, including unfinished setup.
// Detachment invokes every disposer synchronously before waiting for destruction.
const createMicTestResources = (isCurrent: () => boolean) => {
	const disposers: (() => void | Promise<void>)[] = [];
	let detached = false;
	const own = <T>(resource: T, dispose: (value: T) => void | Promise<void>): T => {
		if (detached || !isCurrent()) {
			void Promise.resolve(dispose(resource)).catch(() => {});
		} else {
			disposers.push(() => dispose(resource));
		}
		return resource;
	};
	const acquire = async <T>(
		promise: Promise<T>,
		dispose: (value: T) => void | Promise<void>,
	): Promise<T | undefined> => {
		const resource = await promise;
		if (detached || !isCurrent()) {
			await dispose(resource);
			return undefined;
		}
		return own(resource, dispose);
	};
	const detach = () => {
		detached = true;
		return Promise.all(
			disposers.splice(0).map((dispose) => {
				try {
					return Promise.resolve(dispose()).catch(() => {});
				} catch {
					return Promise.resolve();
				}
			}),
		).then(() => {});
	};
	return { own, acquire, detach };
};

const runMicTestSetup = async <Capture, Pipeline, Monitor>(ports: {
	resources: ReturnType<typeof createMicTestResources>;
	isCurrent: () => boolean;
	capture: () => Promise<Capture>;
	stopCapture: (capture: Capture) => void;
	pipeline: (capture: Capture) => Promise<Pipeline>;
	destroyPipeline: (pipeline: Pipeline) => void | Promise<void>;
	monitor: (capture: Capture, pipeline: Pipeline | undefined) => Monitor;
	resume: (monitor: Monitor) => Promise<void>;
	onReady: (monitor: Monitor) => void;
}): Promise<void> => {
	const capture = await ports.resources.acquire(ports.capture(), ports.stopCapture);
	if (capture === undefined || !ports.isCurrent()) return;
	const pipeline = await ports.resources.acquire(ports.pipeline(capture), ports.destroyPipeline);
	if (!ports.isCurrent()) return;
	// An undefined pipeline means browser passthrough, not a failed acquisition.
	const monitor = ports.monitor(capture, pipeline);
	await ports.resume(monitor);
	if (ports.isCurrent()) ports.onReady(monitor);
};

export { createMicTestResources, runMicTestSetup };
