import { describe, expect, it } from 'bun:test';
import { createInitialVoiceSessionState, reduceVoiceSession } from '@/features/server/voice/voice-session-machine';
import {
	resolveTransportRecoveryCircuitDecision,
	shouldReleaseTransportFailureLatch,
	type TTransportRecoveryCircuitState,
} from '../transport-recovery-circuit';

describe('transport recovery circuit', () => {
	it('stops after the allowed rapid recovery cycles', () => {
		let state: TTransportRecoveryCircuitState | undefined;
		const actions: string[] = [];

		for (let failure = 0; failure < 4; failure += 1) {
			const decision = resolveTransportRecoveryCircuitDecision({
				state,
				channelId: 7,
				now: failure * 1_000,
			});
			state = decision.state;
			actions.push(decision.action);
		}

		expect(actions).toEqual(['recover', 'recover', 'recover', 'stop']);
	});

	it('starts a fresh budget after a stable interval or channel change', () => {
		const exhaustedSequence = {
			channelId: 7,
			lastFailureAt: 2_000,
			rapidFailureCount: 3,
		};

		expect(
			resolveTransportRecoveryCircuitDecision({ state: exhaustedSequence, channelId: 7, now: 32_000 }).action,
		).toBe('recover');
		expect(resolveTransportRecoveryCircuitDecision({ state: exhaustedSequence, channelId: 8, now: 2_001 }).action).toBe(
			'recover',
		);
	});

	it('releases the failure latch when exhaustion is ignored during websocket recovery', () => {
		const reconnecting = reduceVoiceSession(createInitialVoiceSessionState(), {
			type: 'WsDropped',
			pending: {
				channelId: 7,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [],
				expiresAt: 10_000,
			},
			now: 100,
			online: true,
			authenticated: true,
		}).state;
		const ignoredExhaustion = reduceVoiceSession(reconnecting, {
			type: 'TransportRecoveryExhausted',
			channelId: 7,
		});

		expect(
			shouldReleaseTransportFailureLatch({
				action: 'stop',
				commandCount: ignoredExhaustion.commands.length,
				phase: ignoredExhaustion.state.phase.phase,
			}),
		).toBe(true);
	});

	it('keeps the failure latch until terminal cleanup when exhaustion is accepted', () => {
		const connected = reduceVoiceSession(createInitialVoiceSessionState(), {
			type: 'JoinRequested',
			channelId: 7,
		}).state;
		const joined = reduceVoiceSession(connected, { type: 'JoinSucceeded', channelId: 7 }).state;
		const acceptedExhaustion = reduceVoiceSession(joined, {
			type: 'TransportRecoveryExhausted',
			channelId: 7,
		});

		expect(
			shouldReleaseTransportFailureLatch({
				action: 'stop',
				commandCount: acceptedExhaustion.commands.length,
				phase: acceptedExhaustion.state.phase.phase,
			}),
		).toBe(false);
	});
});
