import { logDebug } from '@/helpers/browser-logger';
import { useServerStore } from '../slice';
import {
	selectPendingVoiceReconnect,
	selectReconnectAuthenticated,
	selectReconnectingSince,
	selectVoiceReconnectSuppression,
} from './voice-session-machine';
import { dispatchVoiceSession, selectVoiceSessionState } from './voice-session-store';

type TPendingVoiceReconnect = {
	channelId: number;
	micMuted: boolean;
	soundMuted: boolean;
	peerUserIds: number[];
	expiresAt: number;
};

type TVoiceReconnectSuppression = {
	channelId: number;
	peerUserIds: number[];
	expiresAt: number;
};

// Mirrors the server's VOICE_DISCONNECT_GRACE_MS. Keeping these aligned ensures
// a restore attempt still racing in after the server has finalized cleanup
// fails the grace window outright instead of silently degrading into a fresh
// voice.join the user did not ask for.
const VOICE_RECONNECT_INTENT_TTL_MS = 60_000;

type TClearReason =
	| 'user-left-voice'
	| 'kicked'
	| 'banned'
	| 'session-replaced'
	| 'user-started-voice-join'
	| 'join-failed'
	| 'restore-conflict'
	| 'restore-terminal-error'
	| 'reconnect-expired'
	| 'logout'
	| 'desktop-quit'
	| 'app-teardown';

type TVoiceRecoveryAction =
	| { kind: 'none' }
	| { kind: 'session-present'; channelId: number }
	| { kind: 'session-missing'; channelId: number };

const getMachinePendingVoiceReconnect = (): TPendingVoiceReconnect | undefined =>
	selectVoiceSessionState(selectPendingVoiceReconnect);

const getMachineReconnectingSince = (): number | undefined => selectVoiceSessionState(selectReconnectingSince);

const getMachineReconnectAuthenticated = (): boolean => selectVoiceSessionState(selectReconnectAuthenticated);

const getMachineVoiceReconnectSuppression = (): TVoiceReconnectSuppression | undefined =>
	selectVoiceSessionState(selectVoiceReconnectSuppression);

const isBrowserOnline = (): boolean => {
	if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
		return true;
	}

	return navigator.onLine;
};

const snapshotVoiceReconnectIntent = (opts: { expiresAt: number }): void => {
	const serverState = useServerStore.getState();
	const { currentVoiceChannelId, ownUserId, voiceMap, ownVoiceDefaults } = serverState;

	if (currentVoiceChannelId === undefined || ownUserId === undefined) {
		return;
	}

	const channelUsers = voiceMap[currentVoiceChannelId]?.users ?? {};
	const peerUserIds = Object.keys(channelUsers)
		.map(Number)
		.filter((id) => id !== ownUserId);

	const pendingVoiceReconnect: TPendingVoiceReconnect = {
		channelId: currentVoiceChannelId,
		micMuted: ownVoiceDefaults.micMuted,
		soundMuted: ownVoiceDefaults.soundMuted,
		peerUserIds: [...peerUserIds],
		expiresAt: opts.expiresAt,
	};

	dispatchVoiceSession({ type: 'ReconnectIntentCaptured', pending: pendingVoiceReconnect });

	logDebug('Voice reconnect intent snapshotted', {
		channelId: currentVoiceChannelId,
		peerCount: peerUserIds.length,
		expiresAt: opts.expiresAt,
	});
};

const captureVoiceReconnectIntentForCurrentSession = (): boolean => {
	const serverState = useServerStore.getState();

	if (serverState.currentVoiceChannelId === undefined || serverState.ownUserId === undefined) {
		return false;
	}

	snapshotVoiceReconnectIntent({
		expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS,
	});

	return true;
};

const ensureVoiceReconnectStarted = (timestamp = Date.now()): void => {
	const reconnectingSince = getMachineReconnectingSince();

	if (reconnectingSince !== undefined) {
		return;
	}

	dispatchVoiceSession({
		type: 'ReconnectStarted',
		now: timestamp,
		online: isBrowserOnline(),
		authenticated: getMachineReconnectAuthenticated(),
	});
};

// Called when a WS drop is detected: the next socket must re-authenticate before
// voice recovery may run restoreOrJoin.
const markVoiceReconnectSessionUnauthenticated = (): void => {
	dispatchVoiceSession({ type: 'SocketUnauthenticated' });
};

// Called once joinServer succeeds on the reconnected socket, unblocking the
// gated voice recovery.
const markVoiceReconnectSessionAuthenticated = (): void => {
	dispatchVoiceSession({ type: 'SocketAuthenticated' });
};

const clearVoiceReconnectRecovery = (reason: TClearReason): void => {
	logDebug('clearVoiceReconnectRecovery', { reason });
	dispatchVoiceSession({ type: 'RecoveryCleared', reason });
};

const isVoiceReconnectRecoveryActive = (): boolean =>
	selectVoiceSessionState((state) => state.phase.phase === 'reconnecting');

const getValidPendingVoiceReconnect = (): TPendingVoiceReconnect | undefined => {
	const pendingVoiceReconnect = getMachinePendingVoiceReconnect();

	if (!pendingVoiceReconnect || Date.now() > pendingVoiceReconnect.expiresAt) {
		return undefined;
	}

	return pendingVoiceReconnect;
};

const isVoiceReconnectPeerSuppressed = (channelId: number, userId: number): boolean => {
	const voiceReconnectSuppression = getMachineVoiceReconnectSuppression();

	if (!voiceReconnectSuppression || Date.now() > voiceReconnectSuppression.expiresAt) {
		return false;
	}

	return voiceReconnectSuppression.channelId === channelId && voiceReconnectSuppression.peerUserIds.includes(userId);
};

const resolveVoiceRecoveryAction = (): TVoiceRecoveryAction => {
	const pendingVoiceReconnect = getValidPendingVoiceReconnect();

	if (!pendingVoiceReconnect) {
		return { kind: 'none' };
	}

	const serverState = useServerStore.getState();
	const { ownUserId, voiceMap } = serverState;
	const { channelId } = pendingVoiceReconnect;

	const channelState = voiceMap[channelId];
	const stillInVoice = ownUserId !== undefined && channelState?.users[ownUserId] !== undefined;

	if (stillInVoice) {
		return { kind: 'session-present', channelId };
	}

	return { kind: 'session-missing', channelId };
};

export type { TClearReason, TPendingVoiceReconnect, TVoiceReconnectSuppression, TVoiceRecoveryAction };
export {
	captureVoiceReconnectIntentForCurrentSession,
	clearVoiceReconnectRecovery,
	ensureVoiceReconnectStarted,
	getValidPendingVoiceReconnect,
	isVoiceReconnectPeerSuppressed,
	isVoiceReconnectRecoveryActive,
	markVoiceReconnectSessionAuthenticated,
	markVoiceReconnectSessionUnauthenticated,
	resolveVoiceRecoveryAction,
	snapshotVoiceReconnectIntent,
	VOICE_RECONNECT_INTENT_TTL_MS,
};
