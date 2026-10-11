import type { TStreamEventDetails } from '@sharkord/shared';
import { createStreamEventCollector } from './stream-event-collector';

// Configured by tRPC after join/authentication. No import of the network layer
// here: media code can record events without creating a circular dependency.
let collector: ReturnType<typeof createStreamEventCollector> | undefined;

export const configureStreamObservability = (
	options: Parameters<typeof createStreamEventCollector>[0],
	identity: string,
	supported: boolean,
) => {
	try {
		collector ??= createStreamEventCollector(options);
		collector.configure(identity, supported, options.upload);
	} catch {
		/* Diagnostics are optional. */
	}
};
export const authenticateStreamObservability = () => collector?.authenticate();
export const pauseStreamObservability = () => collector?.pause();
export const clearStreamObservability = () => collector?.clear();
export const setStreamReconnectAttemptId = (attemptId: string) => collector?.setReconnectAttemptId(attemptId);
export const recordStreamEvent = (details: TStreamEventDetails) => collector?.record(details);
