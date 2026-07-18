import { describe, expect, it } from 'bun:test';
import {
	createInitialVoiceSessionState,
	reduceVoiceSession,
	type TVoiceSessionState,
} from '@/features/server/voice/voice-session-machine';
import {
	recordTransportRecoverySucceeded,
	resolveTransportFailureDispatchOutcome,
	resolveTransportRecoveryCircuitDecision,
	type TTransportRecoveryCircuitState,
} from '../transport-recovery-circuit';

const connectedSession = (channelId = 7): TVoiceSessionState => {
	const joining = reduceVoiceSession(createInitialVoiceSessionState(), { type: 'JoinRequested', channelId }).state;

	return reduceVoiceSession(joining, { type: 'JoinSucceeded', channelId }).state;
};

const connectedGeneration = (state: TVoiceSessionState): number => {
	if (state.phase.phase !== 'connected') throw new Error('expected connected session');

	return state.phase.generation;
};

describe('transport recovery circuit', () => {
	it('stops after the allowed accepted rapid recovery cycles', () => {
		let state: TTransportRecoveryCircuitState | undefined;
		let generation = 1;
		const actions: string[] = [];

		for (let failure = 0; failure < 4; failure += 1) {
			const now = failure * 1_000;
			const decision = resolveTransportRecoveryCircuitDecision({ state, channelId: 7, generation, now });
			actions.push(decision.action);

			const transition =
				decision.action === 'recover'
					? {
							type: 'failure-accepted' as const,
							channelId: 7,
							connectedGeneration: generation,
							recoveryGeneration: generation + 1,
						}
					: { type: 'exhaustion-accepted' as const, channelId: 7, connectedGeneration: generation };
			state = resolveTransportFailureDispatchOutcome({
				circuitDecision: decision,
				transition,
				previousCircuitState: state,
			}).circuitState;

			if (decision.action === 'recover') {
				generation += 1;
				state = recordTransportRecoverySucceeded({
					state,
					transition: { type: 'rebuild-succeeded', channelId: 7, generation, now: now + 100 },
				});
			}
		}

		expect(actions).toEqual(['recover', 'recover', 'recover', 'stop']);
	});

	it('starts a fresh budget only after the accepted connection is stable', () => {
		const rapidSequence = {
			channelId: 7,
			generation: 3,
			stabilityStartedAt: 2_000,
			rapidFailureCount: 3,
		};

		expect(
			resolveTransportRecoveryCircuitDecision({ state: rapidSequence, channelId: 7, generation: 3, now: 32_000 }),
		).toMatchObject({ action: 'recover', state: { rapidFailureCount: 1 } });
		expect(
			resolveTransportRecoveryCircuitDecision({ state: rapidSequence, channelId: 8, generation: 3, now: 2_001 }),
		).toMatchObject({ action: 'recover', state: { rapidFailureCount: 1 } });
	});

	it('starts a fresh budget when websocket reconnect follows a stable connection', () => {
		const reconnected = recordTransportRecoverySucceeded({
			state: {
				channelId: 7,
				generation: 3,
				stabilityStartedAt: 1_000,
				rapidFailureCount: 3,
			},
			transition: { type: 'reconnect-succeeded', channelId: 7, generation: 4, now: 31_000 },
		});

		expect(reconnected).toEqual({
			channelId: 7,
			generation: 4,
			stabilityStartedAt: 31_000,
			rapidFailureCount: 0,
		});
		expect(
			resolveTransportRecoveryCircuitDecision({ state: reconnected, channelId: 7, generation: 4, now: 31_001 }),
		).toMatchObject({ action: 'recover', state: { rapidFailureCount: 1 } });
	});

	it('preserves rapid failures when websocket reconnect occurs inside the stability window', () => {
		const reconnected = recordTransportRecoverySucceeded({
			state: {
				channelId: 7,
				generation: 3,
				stabilityStartedAt: 1_000,
				rapidFailureCount: 2,
			},
			transition: { type: 'reconnect-succeeded', channelId: 7, generation: 4, now: 30_999 },
		});

		expect(reconnected).toEqual({
			channelId: 7,
			generation: 4,
			stabilityStartedAt: 30_999,
			rapidFailureCount: 2,
		});
		expect(
			resolveTransportRecoveryCircuitDecision({ state: reconnected, channelId: 7, generation: 4, now: 31_000 }),
		).toMatchObject({ action: 'recover', state: { rapidFailureCount: 3 } });
	});

	it('ignores success transitions outside the current circuit identity', () => {
		const state = {
			channelId: 7,
			generation: 3,
			stabilityStartedAt: 1_000,
			rapidFailureCount: 2,
		};

		expect(
			recordTransportRecoverySucceeded({
				state,
				transition: { type: 'reconnect-succeeded', channelId: 8, generation: 4, now: 40_000 },
			}),
		).toBe(state);
		expect(
			recordTransportRecoverySucceeded({
				state,
				transition: { type: 'rebuild-succeeded', channelId: 7, generation: 4, now: 40_000 },
			}),
		).toBe(state);
	});

	it('preserves the budget when websocket recovery ignores a proposed failure', () => {
		const previousCircuitState = {
			channelId: 7,
			generation: 4,
			stabilityStartedAt: 50,
			rapidFailureCount: 1,
		};
		const decision = resolveTransportRecoveryCircuitDecision({
			state: previousCircuitState,
			channelId: 7,
			generation: 4,
			now: 100,
		});
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
		const ignored = reduceVoiceSession(reconnecting, {
			type: 'TransportFailed',
			channelId: 7,
			nonce: 1,
			connectedGeneration: 4,
		});

		expect(
			resolveTransportFailureDispatchOutcome({
				circuitDecision: decision,
				transition: ignored.transportRecoveryTransition,
				previousCircuitState,
			}),
		).toEqual({ accepted: false, circuitState: previousCircuitState });
	});

	it('preserves an exhausted budget when websocket recovery ignores terminal cleanup', () => {
		const previousCircuitState = {
			channelId: 7,
			generation: 4,
			stabilityStartedAt: 50,
			rapidFailureCount: 3,
		};
		const decision = resolveTransportRecoveryCircuitDecision({
			state: previousCircuitState,
			channelId: 7,
			generation: 4,
			now: 100,
		});
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
		const ignored = reduceVoiceSession(reconnecting, {
			type: 'TransportRecoveryExhausted',
			channelId: 7,
			connectedGeneration: 4,
		});

		expect(decision.action).toBe('stop');
		expect(
			resolveTransportFailureDispatchOutcome({
				circuitDecision: decision,
				transition: ignored.transportRecoveryTransition,
				previousCircuitState,
			}),
		).toEqual({ accepted: false, circuitState: previousCircuitState });
	});

	it('preserves the budget for duplicate and stale-generation failures', () => {
		const connected = connectedSession();
		const generation = connectedGeneration(connected);
		const previousCircuitState = {
			channelId: 7,
			generation,
			stabilityStartedAt: 50,
			rapidFailureCount: 1,
		};
		const decision = resolveTransportRecoveryCircuitDecision({
			state: previousCircuitState,
			channelId: 7,
			generation,
			now: 100,
		});
		const accepted = reduceVoiceSession(connected, {
			type: 'TransportFailed',
			channelId: 7,
			nonce: 1,
			connectedGeneration: generation,
		});
		const acceptedOutcome = resolveTransportFailureDispatchOutcome({
			circuitDecision: decision,
			transition: accepted.transportRecoveryTransition,
			previousCircuitState,
		});
		const duplicate = reduceVoiceSession(accepted.state, {
			type: 'TransportFailed',
			channelId: 7,
			nonce: 1,
			connectedGeneration: generation,
		});
		const stale = reduceVoiceSession(connected, {
			type: 'TransportFailed',
			channelId: 7,
			nonce: 1,
			connectedGeneration: generation + 1,
		});

		expect(acceptedOutcome.accepted).toBe(true);
		expect(acceptedOutcome.circuitState?.rapidFailureCount).toBe(2);
		expect(
			resolveTransportFailureDispatchOutcome({
				circuitDecision: decision,
				transition: duplicate.transportRecoveryTransition,
				previousCircuitState: acceptedOutcome.circuitState,
			}),
		).toEqual({ accepted: false, circuitState: acceptedOutcome.circuitState });
		expect(stale.transportRecoveryTransition).toBeUndefined();
	});

	it('keeps an immediate replacement failure rapid after a slow successful rebuild', () => {
		let machineState = connectedSession();
		const firstConnectedGeneration = connectedGeneration(machineState);
		const firstDecision = resolveTransportRecoveryCircuitDecision({
			state: undefined,
			channelId: 7,
			generation: firstConnectedGeneration,
			now: 0,
		});
		const acceptedFailure = reduceVoiceSession(machineState, {
			type: 'TransportFailed',
			channelId: 7,
			nonce: 1,
			connectedGeneration: firstConnectedGeneration,
		});
		let circuitState = resolveTransportFailureDispatchOutcome({
			circuitDecision: firstDecision,
			transition: acceptedFailure.transportRecoveryTransition,
			previousCircuitState: undefined,
		}).circuitState;

		const snapshotCommand = acceptedFailure.commands[0];
		if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') throw new Error('expected snapshot command');
		const recoveryStarted = reduceVoiceSession(acceptedFailure.state, {
			type: 'RecoveryStarted',
			commandId: snapshotCommand.commandId,
			generation: snapshotCommand.generation,
			snapshot: { remoteUserStreams: {}, externalStreams: {} },
		});
		const rebuildCommand = recoveryStarted.commands[0];
		if (rebuildCommand?.type !== 'RebuildTransports') throw new Error('expected rebuild command');
		const rebuildSucceeded = reduceVoiceSession(recoveryStarted.state, {
			type: 'RebuildSucceeded',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
			now: 40_000,
		});
		if (rebuildSucceeded.transportRecoveryTransition?.type !== 'rebuild-succeeded') {
			throw new Error('expected accepted rebuild success');
		}

		machineState = rebuildSucceeded.state;
		circuitState = recordTransportRecoverySucceeded({
			state: circuitState,
			transition: rebuildSucceeded.transportRecoveryTransition,
		});
		const immediateFailure = resolveTransportRecoveryCircuitDecision({
			state: circuitState,
			channelId: 7,
			generation: connectedGeneration(machineState),
			now: 40_001,
		});

		expect(immediateFailure.state.rapidFailureCount).toBe(2);
	});
});
