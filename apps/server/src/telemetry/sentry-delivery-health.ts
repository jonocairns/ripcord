import type * as Sentry from '@sentry/bun';
import { telemetryHealth } from './health';

// Observe the standard transport contract, leaving SDK buffering/rate limits and
// request execution with Sentry. No requests or recursive error capture here.
export const withErrorDeliveryHealth =
	(
		factory: typeof Sentry.makeFetchTransport,
		health: Pick<typeof telemetryHealth, 'count'> = telemetryHealth,
	): typeof factory =>
	(options) => {
		const count: typeof health.count = (reason) => {
			try {
				health.count(reason);
			} catch {
				/* Health observers cannot alter transport behavior. */
			}
		};
		const transport = factory({
			...options,
			recordDroppedEvent: (...args) => {
				count('error_transport_dropped');
				options.recordDroppedEvent(...args);
			},
		});
		return {
			send: async (envelope) => {
				try {
					const response = await transport.send(envelope);
					if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300))
						count('error_export_failure');
					return response;
				} catch (error) {
					count('error_export_failure');
					throw error;
				}
			},
			flush: async (timeout) => {
				try {
					const flushed = await transport.flush(timeout);
					if (!flushed) count('error_flush_timeout');
					return flushed;
				} catch (error) {
					count('error_flush_timeout');
					throw error;
				}
			},
		};
	};
