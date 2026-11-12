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

export { createMicTestResources };
