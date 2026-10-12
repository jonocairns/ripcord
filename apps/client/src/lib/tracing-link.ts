import type { AppRouter } from '@sharkord/shared';
import { context, propagation } from '@sharkord/shared/telemetry/propagation';
import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { isTracePropagationEnabled } from '@/helpers/telemetry/backend';
import { startSpanObservation } from '@/helpers/telemetry/tracing';
export const tracingLink: TRPCLink<AppRouter> =
	() =>
	({ op, next }) => {
		if (!isTracePropagationEnabled() || op.type === 'subscription' || op.path.startsWith('telemetry.')) return next(op);
		return observable((observer) => {
			const span = startSpanObservation({
				name: `rpc.${op.path}`,
				op: 'rpc.client',
				attributes: { 'rpc.method': op.path, 'rpc.type': op.type },
			});
			const carrier: Record<string, string> = {};
			try {
				span.run(() => propagation.inject(context.active(), carrier));
			} catch {
				/* Propagation is optional. */
			}
			const input = carrier.traceparent
				? {
						__ripcordTrace: {
							traceparent: carrier.traceparent,
							...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
						},
						input: op.input,
					}
				: op.input;
			const subscription = span.run(() =>
				next({ ...op, input }).subscribe({
					next: (value) => observer.next(value),
					error: (error) => {
						span.finish({ status: 'error' });
						observer.error(error);
					},
					complete: () => {
						span.finish({ status: 'ok' });
						observer.complete();
					},
				}),
			);
			return () => {
				subscription.unsubscribe();
				span.finish({ status: 'unset' });
			};
		});
	};
