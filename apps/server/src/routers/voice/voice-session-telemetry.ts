import type { TSpanObservation, TSpanOptions } from '@sharkord/shared/telemetry/tracing';
import { startSpanObservation } from '../../helpers/tracing';
import { logger } from '../../logger';
import type { TVoiceSessionObserver } from '../../voice-session-observability';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TVoiceSessionTelemetryOptions = {
	now?: () => number;
	createOperationId?: () => string;
	startSpan?: (options: TSpanOptions) => TSpanObservation;
	log?: (event: Record<string, unknown>) => void;
};

const createVoiceSessionTelemetry = (options: TVoiceSessionTelemetryOptions = {}): TVoiceSessionObserver => ({
	startAttempt: (context) => {
		const now = options.now ?? performance.now.bind(performance);
		const operationId = options.createOperationId?.() ?? crypto.randomUUID();
		const startedAt = now();
		const reconnectAttemptId =
			context.reconnectAttemptId && UUID_PATTERN.test(context.reconnectAttemptId)
				? context.reconnectAttemptId
				: undefined;
		const span = (options.startSpan ?? startSpanObservation)({
			name: 'voice.session_attempt',
			op: 'voice.session',
			attributes: {
				'voice.kind': context.kind,
				'voice.has_client_instance_id': context.hasClientInstanceId,
			},
		});
		let finished = false;
		const base = {
			operationId,
			kind: context.kind,
			hasClientInstanceId: context.hasClientInstanceId,
			...(reconnectAttemptId ? { reconnectAttemptId } : {}),
		};
		const logEvent = (event: Record<string, unknown>): void => {
			try {
				if (options.log) {
					options.log(event);
				} else {
					logger.info({ message: '[voice-session]', ...event });
				}
			} catch {
				// Telemetry must never change voice-session behavior.
			}
		};

		return {
			pairObserver: (event) => {
				logEvent({ event: 'voice_transport_pair', ...base, ...event });
			},
			finish: ({ path, outcome }) => {
				if (finished) {
					return;
				}

				finished = true;
				const durationMs = Math.max(0, now() - startedAt);
				span.finish({
					attributes: { 'voice.path': path, 'voice.outcome': outcome, 'voice.duration_ms': durationMs },
					status:
						outcome === 'succeeded' ? 'ok' : outcome === 'cancelled' || outcome === 'superseded' ? 'unset' : 'error',
					statusMessage: outcome,
				});
				logEvent({
					event: 'voice_session_attempt_finished',
					...base,
					path,
					outcome,
					durationMs,
				});
			},
		};
	},
});

const voiceSessionTelemetry = createVoiceSessionTelemetry();

export { createVoiceSessionTelemetry, voiceSessionTelemetry };
