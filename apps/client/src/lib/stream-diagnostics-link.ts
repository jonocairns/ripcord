import type { AppRouter } from '@sharkord/shared';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';

// wsLink does not honor mutation AbortSignals. Release its request subscription
// when diagnostics time out or change identity, including the retained payload.
// Unsubscribing cannot undo a mutation that already reached the server.
export const streamDiagnosticsLink: TRPCLink<AppRouter> =
	() =>
	({ op, next }) => {
		const signal = op.signal;
		if (op.type !== 'mutation' || op.path !== 'voice.reportStreamEvents' || !signal) return next(op);
		return observable((observer) => {
			const onAbort = () => observer.error(TRPCClientError.from(new Error('Stream diagnostics upload cancelled')));
			if (signal.aborted) {
				onAbort();
				return;
			}
			const subscription = next(op).subscribe(observer);
			signal.addEventListener('abort', onAbort, { once: true });
			// A downstream link may abort synchronously during subscription.
			if (signal.aborted) onAbort();
			return () => {
				signal.removeEventListener('abort', onAbort);
				subscription.unsubscribe();
			};
		});
	};
