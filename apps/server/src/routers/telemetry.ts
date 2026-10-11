import { clientTraceBatchSchema, diagnosticBatchSchema } from '@sharkord/shared';
import { diagnosticIngest } from '../telemetry/diagnostics';
import { clientTraceRelay } from '../telemetry/traces';
import { protectedProcedure, rateLimitedProcedure, t } from '../utils/trpc';
export const telemetryRouter = t.router({
	reportTraces: rateLimitedProcedure(protectedProcedure, {
		maxRequests: 30,
		windowMs: 60000,
		keyBy: 'user',
		logLabel: 'traces',
	})
		.input(clientTraceBatchSchema)
		.mutation(({ input, ctx }) => {
			clientTraceRelay?.accept(input, ctx.user.id);
		}),
	reportDiagnostics: rateLimitedProcedure(protectedProcedure, {
		maxRequests: 30,
		windowMs: 60_000,
		keyBy: 'user',
		logLabel: 'diagnostics',
	})
		.input(diagnosticBatchSchema)
		.mutation(({ input, ctx }) => {
			diagnosticIngest.accept(input, ctx.user.id);
			// Ack means accepted for best-effort asynchronous processing, not provider delivery.
		}),
});
