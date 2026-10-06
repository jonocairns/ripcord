import type {
	TVoiceSessionCommandObserver,
	TVoiceSessionCommandOutcome,
} from '@/features/server/voice/voice-session-command-executor';
import { startSentrySpanObservation } from '@/helpers/error-reporting/sentry-client';

const isErrorOutcome = (outcome: TVoiceSessionCommandOutcome): boolean =>
	outcome === 'failed' || outcome === 'expired' || outcome === 'detached';

const voiceSessionCommandObserver: TVoiceSessionCommandObserver = {
	start: (context) => {
		const span = startSentrySpanObservation({
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

		return {
			run: span.run,
			finish: ({ outcome, durationMs }) => {
				span.finish({
					attributes: {
						'voice.outcome': outcome,
						'voice.duration_ms': durationMs,
					},
					status: isErrorOutcome(outcome) ? 'error' : 'ok',
					statusMessage: outcome,
				});
			},
		};
	},
};

export { voiceSessionCommandObserver };
