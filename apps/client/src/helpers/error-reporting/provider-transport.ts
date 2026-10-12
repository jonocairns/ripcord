import type { makeFetchTransport } from '@sentry/react';

type TProviderTransport = ReturnType<typeof makeFetchTransport>;

// The SDK parses errors locally; only explicitly configured replay may use its
// provider transport. beforeSend alone does not suppress sessions/client reports.
export const createReplayOnlyTransport = (transport?: TProviderTransport): TProviderTransport => ({
	send: (envelope) => {
		if (
			!transport ||
			envelope[1].length === 0 ||
			envelope[1].some(([header]) => header.type !== 'replay_event' && header.type !== 'replay_recording')
		) {
			return Promise.resolve({});
		}
		return transport.send(envelope);
	},
	flush: (timeout) => transport?.flush(timeout) ?? Promise.resolve(true),
});
