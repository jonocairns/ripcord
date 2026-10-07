// Socket connectivity precedes joinServer authentication. Keep this gate
// independent of voice recovery state, which an explicit leave clears early.
const createSessionAuthenticationGate = () => {
	let authenticated = false;
	const waiters = new Set<{ resolve: () => void; reject: (reason: unknown) => void }>();

	return {
		invalidate: () => {
			authenticated = false;
		},
		authenticate: () => {
			authenticated = true;
			for (const waiter of [...waiters]) waiter.resolve();
		},
		cancel: (reason: unknown) => {
			authenticated = false;
			for (const waiter of [...waiters]) waiter.reject(reason);
		},
		wait: (signal: AbortSignal): Promise<void> => {
			if (signal.aborted) return Promise.reject(signal.reason);
			if (authenticated) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const cleanup = () => {
					waiters.delete(waiter);
					signal.removeEventListener('abort', abort);
				};
				const waiter = {
					resolve: () => {
						cleanup();
						resolve();
					},
					reject: (reason: unknown) => {
						cleanup();
						reject(reason);
					},
				};
				const abort = () => waiter.reject(signal.reason);
				waiters.add(waiter);
				signal.addEventListener('abort', abort, { once: true });
			});
		},
	};
};

export { createSessionAuthenticationGate };
