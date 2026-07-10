import { beforeEach, describe, expect, it } from 'bun:test';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	resetVoiceSessionStoreForTest,
	selectVoiceSessionState,
	subscribeVoiceSession,
} from '../voice-session-store';

describe('voice session store', () => {
	beforeEach(() => {
		resetVoiceSessionStoreForTest();
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
});
