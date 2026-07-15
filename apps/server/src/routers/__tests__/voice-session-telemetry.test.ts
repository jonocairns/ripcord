import { describe, expect, test } from 'bun:test';
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
});
