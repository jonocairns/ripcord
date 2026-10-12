import { diagnosticBatchSchema } from '@sharkord/shared';
import { diagnosticIngest } from '../telemetry/diagnostics';
import { protectedProcedure, rateLimitedProcedure, t } from '../utils/trpc';
export const telemetryRouter = t.router({
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
