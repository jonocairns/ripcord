import type {
	TVoiceSessionCommandObserver,
	TVoiceSessionCommandOutcome,
} from '@/features/server/voice/voice-session-command-executor';
import { recordVoiceDiagnostic } from '@/helpers/browser-logger';
import { recordDesktopDiagnostic } from '@/helpers/desktop-diagnostics';
import { getDiagnosticIdentity } from '@/helpers/error-reporting/delivery';
import { startSpanObservation } from '@/helpers/telemetry/tracing';

const isErrorOutcome = (outcome: TVoiceSessionCommandOutcome): boolean =>
	outcome === 'failed' || outcome === 'expired' || outcome === 'detached';

const voiceSessionCommandObserver: TVoiceSessionCommandObserver = {
	start: (context) => {
		recordDesktopDiagnostic('voice_command_started', context);
		const diagnosticIdentity = getDiagnosticIdentity();
		const span = startSpanObservation({
			name: 'voice.session_command',
			op: 'voice.session',
			attributes: {
				'voice.command_type': context.commandType,
				'voice.command_id': context.commandId,
				'voice.generation': context.generation,
				'voice.phase': context.phase,
				'voice.attempt': context.attempt,
			},
		});
		span.run(() => recordVoiceDiagnostic('Voice session command started', [context]));

		return {
			run: span.run,
			finish: ({ outcome, durationMs, error }) => {
				if (diagnosticIdentity && diagnosticIdentity === getDiagnosticIdentity())
					span.run(() =>
						recordVoiceDiagnostic(
							'Voice session command finished',
							[{ ...context, outcome, durationMs, error }],
							isErrorOutcome(outcome) ? 'warning' : 'info',
						),
					);
				recordDesktopDiagnostic(
					'voice_command_finished',
					{ ...context, outcome, durationMs, error },
					isErrorOutcome(outcome) ? 'warn' : 'info',
				);
				span.finish({
					attributes: {
						'voice.outcome': outcome,
						'voice.duration_ms': durationMs,
					},
					status: isErrorOutcome(outcome) ? 'error' : outcome === 'succeeded' ? 'ok' : 'unset',
					statusMessage: outcome,
				});
			},
		};
	},
};

export { voiceSessionCommandObserver };
