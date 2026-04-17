import { create } from 'zustand';
import { logDebug } from '@/helpers/browser-logger';
import { useServerStore } from '../slice';

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

type TClearReason =
	| 'user-left-voice'
	| 'kicked'
	| 'banned'
	| 'session-replaced'
	| 'voice-join-succeeded'
	| 'reconnect-expired'
	| 'logout'
	| 'app-teardown';

type TVoiceRecoveryAction =
	| { kind: 'none' }
	| { kind: 'session-present'; channelId: number }
	| { kind: 'session-missing'; channelId: number };

interface IVoiceReconnectState {
	pendingVoiceReconnect: TPendingVoiceReconnect | undefined;
	reconnectingSince: number | undefined;
	voiceReconnectSuppression: TVoiceReconnectSuppression | undefined;
}

type TVoiceReconnectStore = IVoiceReconnectState & {
	setPendingVoiceReconnect: (intent: TPendingVoiceReconnect) => void;
	setReconnectingSince: (timestamp: number | undefined) => void;
	setVoiceReconnectSuppression: (suppression: TVoiceReconnectSuppression | undefined) => void;
	clearVoiceReconnectRecovery: (reason: TClearReason) => void;
	resetState: () => void;
};

const initialState: IVoiceReconnectState = {
	pendingVoiceReconnect: undefined,
	reconnectingSince: undefined,
	voiceReconnectSuppression: undefined,
};

const useVoiceReconnectStore = create<TVoiceReconnectStore>((set) => ({
	...initialState,

	setPendingVoiceReconnect: (intent) => {
		set({ pendingVoiceReconnect: intent });
	},

	setReconnectingSince: (timestamp) => {
		set({ reconnectingSince: timestamp });
	},

	setVoiceReconnectSuppression: (suppression) => {
		set({ voiceReconnectSuppression: suppression });
	},

	clearVoiceReconnectRecovery: (reason) => {
		logDebug('clearVoiceReconnectRecovery', { reason });
		set({ ...initialState });
	},

	resetState: () => {
		set({ ...initialState });
	},
}));

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

	useVoiceReconnectStore.getState().setPendingVoiceReconnect({
		channelId: currentVoiceChannelId,
		micMuted: ownVoiceDefaults.micMuted,
		soundMuted: ownVoiceDefaults.soundMuted,
		peerUserIds: [...peerUserIds],
		expiresAt: opts.expiresAt,
	});

	logDebug('Voice reconnect intent snapshotted', {
		channelId: currentVoiceChannelId,
		peerCount: peerUserIds.length,
		expiresAt: opts.expiresAt,
	});
};

const clearVoiceReconnectRecovery = (reason: TClearReason): void => {
	useVoiceReconnectStore.getState().clearVoiceReconnectRecovery(reason);
};

const resolveVoiceRecoveryAction = (): TVoiceRecoveryAction => {
	const { pendingVoiceReconnect } = useVoiceReconnectStore.getState();

	if (!pendingVoiceReconnect || Date.now() > pendingVoiceReconnect.expiresAt) {
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

export {
	clearVoiceReconnectRecovery,
	resolveVoiceRecoveryAction,
	snapshotVoiceReconnectIntent,
	useVoiceReconnectStore,
};

export type { TClearReason, TPendingVoiceReconnect, TVoiceRecoveryAction, TVoiceReconnectSuppression };
