import { afterEach, beforeEach, expect, it } from 'bun:test';
import { useServerStore } from '../../slice';
import {
	captureVoiceReconnectIntentForCurrentSession,
	clearVoiceReconnectRecovery,
	ensureVoiceReconnectStarted,
	getValidPendingVoiceReconnect,
	markVoiceReconnectSessionAuthenticated,
	markVoiceReconnectSessionUnauthenticated,
	updateVoiceReconnectIntentState,
} from '../reconnect-coordinator';
import {
	isCurrentVoiceSessionCommand,
	selectPendingVoiceReconnect,
	type TVoiceSessionCommand,
	type TVoiceSessionEvent,
} from '../voice-session-machine';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	registerVoiceSessionCommandRunner,
	resetVoiceSessionState,
} from '../voice-session-store';

let ready = false;
let online = true;
let active: TVoiceSessionCommand | undefined;
let effects: TVoiceSessionCommand[] = [];
let unregister = (): void => {};
const send = (event: TVoiceSessionEvent): void => {
	dispatchVoiceSession(event);
};
const drop = (): void => {
	ready = false;
	markVoiceReconnectSessionUnauthenticated();
	if (captureVoiceReconnectIntentForCurrentSession()) ensureVoiceReconnectStarted();
};
const sessionAuthenticated = (): void => {
	ready = true;
	markVoiceReconnectSessionAuthenticated();
};
const rejoinCompleted = (): void => {
	if (getValidPendingVoiceReconnect()) ensureVoiceReconnectStarted();
};
const settle = (): void => {
	for (let i = 0; i < 10; i++) {
		const command = active;
		if (!command || !isCurrentVoiceSessionCommand(getVoiceSessionState(), command)) return;
		if (command.type === 'CaptureRecoverySnapshot')
			send({ ...command, type: 'RecoveryStarted', snapshot: { remoteUserStreams: {}, externalStreams: {} } });
		else if (command.type === 'WaitOnline' && online) send({ ...command, type: 'OnlineReady' });
		else if (command.type === 'WaitAuth' && ready) send({ ...command, type: 'AuthReady' });
		else return;
	}
	throw new Error('settle did not converge');
};
const complete = (type: 'RestoreSucceeded' | 'WatchIntentRehydrated' | 'AuthExpired'): void => {
	if (!active) throw new Error('no active command');
	send({ ...active, type, now: Date.now() });
	settle();
};
const phase = () => getVoiceSessionState().phase;
const pending = () => selectPendingVoiceReconnect(getVoiceSessionState());
const names = () => effects.map((command) => command.type);
beforeEach(() => {
	resetVoiceSessionState();
	useServerStore.getState().resetState();
	useServerStore.setState({
		ownUserId: 1,
		currentVoiceChannelId: 5,
		ownVoiceDefaults: { micMuted: true, soundMuted: false, webcamEnabled: false, sharingScreen: false },
	});
	ready = false;
	online = true;
	active = undefined;
	effects = [];
	unregister = registerVoiceSessionCommandRunner((commands) => {
		for (const command of commands) {
			active = command;
			if (!['CaptureRecoverySnapshot', 'WaitOnline', 'WaitAuth', 'RetryDelay'].includes(command.type))
				effects.push(command);
		}
	});
});
afterEach(() => {
	unregister();
	resetVoiceSessionState();
});
it('waits for authentication and restores captured mute intent', () => {
	drop();
	settle();
	expect(names()).toEqual([]);
	expect(phase()).toMatchObject({ phase: 'reconnecting', step: 'waitingAuth' });
	sessionAuthenticated();
	settle();
	expect(names()).toEqual(['RestoreVoiceSession']);
	expect(active).toMatchObject({ pending: { channelId: 5, micMuted: true, soundMuted: false } });
});
it('rehydrates watch intent and finishes with suppression', () => {
	drop();
	sessionAuthenticated();
	settle();
	complete('RestoreSucceeded');
	expect(names()).toEqual(['RestoreVoiceSession', 'RestoreWatchIntent']);
	complete('WatchIntentRehydrated');
	expect(phase()).toMatchObject({ phase: 'connected', channelId: 5 });
	expect(getVoiceSessionState().suppression?.channelId).toBe(5);
	expect(pending()).toBeUndefined();
});
for (const watch of [false, true])
	it(`supersedes a drop during ${watch ? 'watch restore' : 'restore'}`, () => {
		drop();
		sessionAuthenticated();
		settle();
		if (watch) complete('RestoreSucceeded');
		const stale = active;
		const attempt = effects.find((command) => command.type === 'RestoreVoiceSession');
		drop();
		settle();
		if (!stale) throw new Error('no stale command');
		send({ ...stale, type: watch ? 'WatchIntentRehydrated' : 'RestoreSucceeded', now: Date.now() });
		expect(phase()).toMatchObject({ step: 'waitingAuth' });
		sessionAuthenticated();
		settle();
		expect(active).toMatchObject({
			type: 'RestoreVoiceSession',
			attempt: attempt?.type === 'RestoreVoiceSession' ? attempt.attempt : -1,
		});
	});
it('expires without authentication and clears the server seat', () => {
	drop();
	settle();
	complete('AuthExpired');
	expect(active).toMatchObject({ type: 'ClearFailedSession', reason: 'reconnect-expired', leaveServerSession: true });
});
for (const expired of [false, true])
	it(`starts staged intent only after rejoin (${expired ? 'expired' : 'live'})`, () => {
		captureVoiceReconnectIntentForCurrentSession();
		useServerStore.setState({ currentVoiceChannelId: undefined });
		expect(names()).toEqual([]);
		if (expired) {
			const intent = pending();
			if (!intent) throw new Error('no intent');
			send({ type: 'ReconnectIntentCaptured', pending: { ...intent, expiresAt: 0 } });
		}
		sessionAuthenticated();
		rejoinCompleted();
		settle();
		expect(names()).toEqual(expired ? [] : ['RestoreVoiceSession']);
	});
it('ignores a drop outside voice', () => {
	useServerStore.setState({ currentVoiceChannelId: undefined });
	const before = getVoiceSessionState().phase;
	drop();
	settle();
	expect(phase()).toEqual(before);
	expect(pending()).toBeUndefined();
	expect(names()).toEqual([]);
});
it('supersedes recovery after the own channel has been cleared', () => {
	captureVoiceReconnectIntentForCurrentSession();
	useServerStore.setState({ currentVoiceChannelId: undefined });
	sessionAuthenticated();
	rejoinCompleted();
	settle();
	drop();
	settle();
	expect(phase()).toMatchObject({ step: 'waitingAuth' });
	sessionAuthenticated();
	settle();
	expect(names()).toEqual(['RestoreVoiceSession', 'RestoreVoiceSession']);
});
it('refreshes the deadline on a second waiting drop', () => {
	drop();
	settle();
	const intent = pending();
	if (!intent) throw new Error('no intent');
	send({ type: 'ReconnectIntentCaptured', pending: { ...intent, expiresAt: 1 } });
	drop();
	settle();
	expect(pending()?.expiresAt).toBeGreaterThan(1);
});
for (const reason of ['kicked', 'user-left-voice'] as const)
	it(`clears recovery on ${reason}`, () => {
		drop();
		settle();
		clearVoiceReconnectRecovery(reason);
		sessionAuthenticated();
		settle();
		expect(phase()).toEqual({ phase: 'idle' });
		expect(names()).toEqual([]);
	});
it('resumes a wait under a new generation', () => {
	drop();
	settle();
	const old = active?.generation;
	send({ type: 'Resumed' });
	settle();
	expect(active?.generation).not.toBe(old);
	sessionAuthenticated();
	settle();
	expect(names()).toEqual(['RestoreVoiceSession']);
});
it('resumes watch recovery by restoring transports again', () => {
	drop();
	sessionAuthenticated();
	settle();
	complete('RestoreSucceeded');
	send({ type: 'Resumed' });
	settle();
	expect(names()).toEqual(['RestoreVoiceSession', 'RestoreWatchIntent', 'RestoreVoiceSession']);
});
it('replaces a restore when mute intent changes', () => {
	drop();
	sessionAuthenticated();
	settle();
	updateVoiceReconnectIntentState({ micMuted: false });
	settle();
	expect(names()).toEqual(['RestoreVoiceSession', 'RestoreVoiceSession']);
	expect(active).toMatchObject({ pending: { micMuted: false } });
});
it('ignores stale join lifecycle results during recovery', () => {
	drop();
	settle();
	const before = phase();
	send({ type: 'JoinSucceeded', channelId: 5 });
	send({ type: 'JoinFailed', reason: 'join-failed' });
	expect(phase()).toEqual(before);
	expect(names()).toEqual([]);
});
