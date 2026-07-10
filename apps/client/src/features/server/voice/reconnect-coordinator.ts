import { create } from 'zustand';
import { logDebug } from '@/helpers/browser-logger';
import { useServerStore } from '../slice';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	resetVoiceSessionState,
	subscribeVoiceSession,
} from './voice-session-store';

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
	| 'voice-join-succeeded'
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

interface IVoiceReconnectState {
	pendingVoiceReconnect: TPendingVoiceReconnect | undefined;
	reconnectingSince: number | undefined;
	voiceReconnectSuppression: TVoiceReconnectSuppression | undefined;
	// True once joinServer has re-authenticated the *current* WS connection.
	// A reconnected socket starts unauthenticated (server createContext sets
	// authenticated: false), so voice recovery must wait for this before issuing
	// the protected restoreOrJoin — otherwise the buffered mutation flushes onto
	// the fresh socket ahead of joinServer and fails UNAUTHORIZED (terminal).
	reconnectAuthenticated: boolean;
}

type TVoiceReconnectStore = IVoiceReconnectState & {
	setPendingVoiceReconnect: (intent: TPendingVoiceReconnect) => void;
	setReconnectingSince: (timestamp: number | undefined) => void;
	setVoiceReconnectSuppression: (suppression: TVoiceReconnectSuppression | undefined) => void;
	setReconnectAuthenticated: (value: boolean) => void;
	clearVoiceReconnectRecovery: (reason: TClearReason) => void;
	resetState: () => void;
};

const initialState: IVoiceReconnectState = {
	pendingVoiceReconnect: undefined,
	reconnectingSince: undefined,
	voiceReconnectSuppression: undefined,
	reconnectAuthenticated: false,
};

const voiceReconnectStateFromMachine = (): IVoiceReconnectState => {
	const { pendingVoiceReconnect, phase, reconnectAuthenticated, reconnectingSince, suppression } =
		getVoiceSessionState();

	if (phase.phase !== 'reconnecting') {
		return {
			pendingVoiceReconnect,
			reconnectingSince,
			voiceReconnectSuppression: suppression,
			reconnectAuthenticated,
		};
	}

	return {
		pendingVoiceReconnect: phase.pending,
		reconnectingSince: phase.reconnectingSince,
		voiceReconnectSuppression: suppression,
		reconnectAuthenticated: phase.authenticated,
	};
};

const syncVoiceReconnectProjection = (): void => {
	useVoiceReconnectStore.setState({
		...voiceReconnectStateFromMachine(),
	});
};

const getMachinePendingVoiceReconnect = (): TPendingVoiceReconnect | undefined => {
	const { pendingVoiceReconnect, phase } = getVoiceSessionState();

	return phase.phase === 'reconnecting' ? phase.pending : pendingVoiceReconnect;
};

const getMachineReconnectingSince = (): number | undefined => {
	const { phase, reconnectingSince } = getVoiceSessionState();

	return phase.phase === 'reconnecting' ? phase.reconnectingSince : reconnectingSince;
};

const getMachineReconnectAuthenticated = (): boolean => {
	const { phase, reconnectAuthenticated } = getVoiceSessionState();

	return phase.phase === 'reconnecting' ? phase.authenticated : reconnectAuthenticated;
};

const getMachineVoiceReconnectSuppression = (): TVoiceReconnectSuppression | undefined =>
	getVoiceSessionState().suppression;

const isBrowserOnline = (): boolean => {
	if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
		return true;
	}

	return navigator.onLine;
};

const useVoiceReconnectStore = create<TVoiceReconnectStore>((set) => ({
	...initialState,

	setPendingVoiceReconnect: (intent) => {
		dispatchVoiceSession({ type: 'ReconnectIntentCaptured', pending: intent });
		syncVoiceReconnectProjection();
	},

	setReconnectingSince: (timestamp) => {
		if (timestamp !== undefined) {
			dispatchVoiceSession({
				type: 'ReconnectStarted',
				now: timestamp,
				online: isBrowserOnline(),
				authenticated: getMachineReconnectAuthenticated(),
			});
			syncVoiceReconnectProjection();
			return;
		}

		dispatchVoiceSession({ type: 'ReconnectStartCleared' });
		syncVoiceReconnectProjection();
	},

	setReconnectAuthenticated: (value) => {
		dispatchVoiceSession({ type: value ? 'SocketAuthenticated' : 'SocketUnauthenticated' });
		syncVoiceReconnectProjection();
	},

	setVoiceReconnectSuppression: (suppression) => {
		dispatchVoiceSession({ type: 'ReconnectSuppressionChanged', suppression });
		syncVoiceReconnectProjection();
	},

	clearVoiceReconnectRecovery: (reason) => {
		logDebug('clearVoiceReconnectRecovery', { reason });
		dispatchVoiceSession({ type: 'RecoveryCleared', reason });
		set({ ...initialState });
	},

	resetState: () => {
		resetVoiceSessionState();
		set({ ...initialState });
	},
}));

// Keep the zustand projection in lockstep with every machine transition. This
// runs as a session-store listener registered at module eval, which strictly
// precedes the VoiceProvider's command-runner subscription (a mount effect) —
// so command runners that read the projection (waitForVoiceReconnectAuthenticated
// and friends) always observe post-dispatch state. Without this, a command
// emitted synchronously inside a dispatch (e.g. WaitAuth right after
// ReconnectStarted) reads the pre-dispatch projection, sees reconnectingSince
// undefined, and aborts recovery as 'cleared'. It also covers machine
// transitions triggered from the provider (e.g. WatchIntentRehydrated), which
// don't go through the coordinator setters at all.
subscribeVoiceSession(() => {
	syncVoiceReconnectProjection();
});

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
	syncVoiceReconnectProjection();

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
	syncVoiceReconnectProjection();
};

// Called when a WS drop is detected: the next socket must re-authenticate before
// voice recovery may run restoreOrJoin.
const markVoiceReconnectSessionUnauthenticated = (): void => {
	dispatchVoiceSession({ type: 'SocketUnauthenticated' });
	syncVoiceReconnectProjection();
};

// Called once joinServer succeeds on the reconnected socket, unblocking the
// gated voice recovery.
const markVoiceReconnectSessionAuthenticated = (): void => {
	dispatchVoiceSession({ type: 'SocketAuthenticated' });
	syncVoiceReconnectProjection();
};

const clearVoiceReconnectRecovery = (reason: TClearReason): void => {
	useVoiceReconnectStore.getState().clearVoiceReconnectRecovery(reason);
};

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
	markVoiceReconnectSessionAuthenticated,
	markVoiceReconnectSessionUnauthenticated,
	resolveVoiceRecoveryAction,
	snapshotVoiceReconnectIntent,
	useVoiceReconnectStore,
	VOICE_RECONNECT_INTENT_TTL_MS,
};
