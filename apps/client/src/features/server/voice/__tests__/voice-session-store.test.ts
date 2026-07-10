import { beforeEach, describe, expect, it } from 'bun:test';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	resetVoiceSessionState,
	selectVoiceSessionState,
	subscribeVoiceSession,
} from '../voice-session-store';

describe('voice session store', () => {
	beforeEach(() => {
		resetVoiceSessionState();
	});

	it('dispatches through the reducer and exposes selector reads', () => {
		const commands = dispatchVoiceSession({ type: 'JoinRequested', channelId: 5 });

		expect(commands).toEqual([]);
		expect(getVoiceSessionState().phase).toEqual({ phase: 'joining', channelId: 5 });
		expect(selectVoiceSessionState((state) => state.phase.phase)).toBe('joining');
	});

	it('notifies subscribers with reducer commands', () => {
		const notifications: Array<{ phase: string; commandTypes: string[] }> = [];
		const unsubscribe = subscribeVoiceSession((state, commands) => {
			notifications.push({
				phase: state.phase.phase,
				commandTypes: commands.map((command) => command.type),
			});
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		unsubscribe();
		dispatchVoiceSession({ type: 'Terminated', reason: 'kicked', channelId: 5 });

		expect(notifications).toEqual([
			{
				phase: 'rebuilding',
				commandTypes: ['CaptureRecoverySnapshot'],
			},
		]);
	});

	it('preserves subscribers when state is reset', () => {
		const observedPhases: string[] = [];
		const unsubscribe = subscribeVoiceSession((state) => {
			observedPhases.push(state.phase.phase);
		});

		resetVoiceSessionState();
		dispatchVoiceSession({ type: 'JoinRequested', channelId: 5 });
		unsubscribe();

		expect(observedPhases).toEqual(['joining']);
	});
});
