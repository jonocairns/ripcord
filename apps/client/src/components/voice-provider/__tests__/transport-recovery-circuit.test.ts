import { describe, expect, it } from 'bun:test';
import {
	resolveTransportRecoveryCircuitDecision,
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
});
