import { describe, expect, test } from 'bun:test';
import type { TSpanObservation } from '@sharkord/shared/telemetry/tracing';
import { createVoiceSessionTelemetry } from '../voice/voice-session-telemetry';

describe('voice session telemetry', () => {
	test('emits bounded pair and terminal metadata with injected duration', () => {
		let now = 10;
		const events: Record<string, unknown>[] = [];
		const telemetry = createVoiceSessionTelemetry({
			now: () => now,
			createOperationId: () => 'operation-1',
			log: (event) => events.push(event),
		});
		const observation = telemetry.startAttempt({
			kind: 'restore',
			reconnectAttemptId: '123e4567-e89b-42d3-a456-426614174000',
			hasClientInstanceId: true,
		});

		observation.pairObserver({ outcome: 'prepared' });
		now = 35;
		observation.finish({ path: 'existing', outcome: 'succeeded' });
		observation.finish({ path: 'existing', outcome: 'postcommit_response_failed' });

		expect(events).toEqual([
			{
				event: 'voice_transport_pair',
				operationId: 'operation-1',
				kind: 'restore',
				hasClientInstanceId: true,
				reconnectAttemptId: '123e4567-e89b-42d3-a456-426614174000',
				outcome: 'prepared',
			},
			{
				event: 'voice_session_attempt_finished',
				operationId: 'operation-1',
				kind: 'restore',
				hasClientInstanceId: true,
				reconnectAttemptId: '123e4567-e89b-42d3-a456-426614174000',
				path: 'existing',
				outcome: 'succeeded',
				durationMs: 25,
			},
		]);
	});

	test('drops an untrusted reconnect label and contains telemetry failures', () => {
		const events: Record<string, unknown>[] = [];
		const safeTelemetry = createVoiceSessionTelemetry({
			createOperationId: () => 'operation-2',
			log: (event) => events.push(event),
		});
		const safeObservation = safeTelemetry.startAttempt({
			kind: 'restore',
			reconnectAttemptId: 'private channel name or attacker-controlled value',
			hasClientInstanceId: false,
		});
		safeObservation.finish({ path: 'fresh', outcome: 'preparation_failed' });
		expect(events[0]).not.toHaveProperty('reconnectAttemptId');

		const telemetry = createVoiceSessionTelemetry({
			createOperationId: () => 'operation-2',
			log: () => {
				throw new Error('logger unavailable');
			},
		});
		const observation = telemetry.startAttempt({
			kind: 'restore',
			reconnectAttemptId: 'another untrusted value',
			hasClientInstanceId: false,
		});

		expect(() => observation.pairObserver({ outcome: 'disposed', cause: 'request_cleanup' })).not.toThrow();
		expect(() => observation.finish({ path: 'fresh', outcome: 'preparation_failed' })).not.toThrow();
	});
	test('reports completed, failed and cancelled attempts without raw error details', () => {
		for (const outcome of ['succeeded', 'preparation_failed', 'cancelled', 'superseded'] as const) {
			const finishes: Parameters<TSpanObservation['finish']>[0][] = [];
			const telemetry = createVoiceSessionTelemetry({
				now: () => 10,
				log: () => {},
				startSpan: () => ({
					run: (effect) => effect(),
					finish: (value) => {
						finishes.push(value);
					},
				}),
			});
			const observation = telemetry.startAttempt({ kind: 'restore', hasClientInstanceId: false });
			observation.finish({ path: 'fresh', outcome, error: new Error('Bearer secret') });
			observation.finish({ path: 'fresh', outcome: 'succeeded' });
			expect(finishes).toEqual([
				{
					attributes: { 'voice.path': 'fresh', 'voice.outcome': outcome, 'voice.duration_ms': 0 },
					status: outcome === 'succeeded' ? 'ok' : outcome === 'preparation_failed' ? 'error' : 'unset',
					statusMessage: outcome,
				},
			]);
		}
	});
});
