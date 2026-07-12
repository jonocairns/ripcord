import type {
	TCategory,
	TChannel,
	TChannelUserPermissionsMap,
	TCommandInfo,
	TCommandsMapByPlugin,
	TExternalStream,
	TExternalStreamsMap,
	TJoinedEmoji,
	TJoinedMessage,
	TJoinedPublicUser,
	TJoinedRole,
	TPublicServerSettings,
	TReadStateMap,
	TServerInfo,
	TVoiceMap,
	TVoiceUserState,
} from '@sharkord/shared';
import { ChannelType } from '@sharkord/shared';
import { create } from 'zustand';
import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import type { TDisconnectInfo, TMessagesMap } from './types';

export interface IServerState {
	connected: boolean;
	connecting: boolean;
	mustChangePassword: boolean;
	disconnectInfo?: TDisconnectInfo;
	serverId?: string;
	categories: TCategory[];
	channels: TChannel[];
	emojis: TJoinedEmoji[];
	ownUserId: number | undefined;
	selectedChannelId: number | undefined;
	lastTextChannelId: number | undefined;
	currentVoiceChannelId: number | undefined;
	voiceSessionReconnectNonce: number;
	messagesMap: TMessagesMap;
	protectedMessagePrefixCounts: Record<number, number>;
	users: TJoinedPublicUser[];
	roles: TJoinedRole[];
	publicSettings: TPublicServerSettings | undefined;
	info: TServerInfo | undefined;
	loadingInfo: boolean;
	voiceMap: TVoiceMap;
	externalStreamsMap: TExternalStreamsMap;
	ownVoiceDefaults: TVoiceUserState;
	ownOptimisticStateExpiresAt: number | undefined;
	pinnedCard: TPinnedCard | undefined;
	channelPermissions: TChannelUserPermissionsMap;
	readStatesMap: {
		[channelId: number]: number | undefined;
	};
	pluginCommands: TCommandsMapByPlugin;
	screenShareWatchers: Record<number, true>;
}

export type TInitialServerData = {
	serverId: string;
	categories: TCategory[];
	channels: TChannel[];
	users: TJoinedPublicUser[];
	ownUserId: number;
	mustChangePassword: boolean;
	roles: TJoinedRole[];
	emojis: TJoinedEmoji[];
	publicSettings?: TPublicServerSettings;
	voiceMap: TVoiceMap;
	externalStreamsMap: TExternalStreamsMap;
	channelPermissions: TChannelUserPermissionsMap;
	readStates: TReadStateMap;
};

type TServerStore = IServerState & {
	resetState: () => void;
	setConnected: (connected: boolean) => void;
	setConnecting: (connecting: boolean) => void;
	setMustChangePassword: (mustChangePassword: boolean) => void;
	setServerId: (serverId: string | undefined) => void;
	setInfo: (info: TServerInfo | undefined) => void;
	setLoadingInfo: (loadingInfo: boolean) => void;
	setDisconnectInfo: (disconnectInfo: TDisconnectInfo | undefined) => void;
	setInitialData: (data: TInitialServerData) => void;
	addMessages: (payload: { channelId: number; messages: TJoinedMessage[]; opts?: { prepend?: boolean } }) => void;
	updateMessage: (payload: { channelId: number; message: TJoinedMessage }) => void;
	deleteMessage: (payload: { channelId: number; messageId: number }) => void;
	setUsers: (users: TJoinedPublicUser[]) => void;
	updateUser: (payload: { userId: number; user: Partial<TJoinedPublicUser> }) => void;
	addUser: (user: TJoinedPublicUser) => void;
	removeUser: (payload: { userId: number }) => void;
	setPublicSettings: (publicSettings: TPublicServerSettings | undefined) => void;
	setRoles: (roles: TJoinedRole[]) => void;
	updateRole: (payload: { roleId: number; role: Partial<TJoinedRole> }) => void;
	addRole: (role: TJoinedRole) => void;
	removeRole: (payload: { roleId: number }) => void;
	setChannels: (channels: TChannel[]) => void;
	updateChannel: (payload: { channelId: number; channel: Partial<TChannel> }) => void;
	addChannel: (channel: TChannel) => void;
	removeChannel: (payload: { channelId: number }) => void;
	setSelectedChannelId: (channelId: number | undefined) => void;
	setCurrentVoiceChannelId: (channelId: number | undefined) => void;
	bumpVoiceSessionReconnectNonce: () => void;
	setChannelPermissions: (channelPermissions: TChannelUserPermissionsMap) => void;
	setChannelReadState: (payload: { channelId: number; count: number | undefined }) => void;
	setEmojis: (emojis: TJoinedEmoji[]) => void;
	updateEmoji: (payload: { emojiId: number; emoji: Partial<TJoinedEmoji> }) => void;
	addEmoji: (emoji: TJoinedEmoji) => void;
	removeEmoji: (payload: { emojiId: number }) => void;
	setCategories: (categories: TCategory[]) => void;
	addCategory: (category: TCategory) => void;
	updateCategory: (payload: { categoryId: number; category: Partial<TCategory> }) => void;
	removeCategory: (payload: { categoryId: number }) => void;
	addUserToVoiceChannel: (payload: { channelId: number; userId: number; state: TVoiceUserState }) => void;
	removeUserFromVoiceChannel: (payload: { channelId: number; userId: number }) => void;
	updateVoiceUserState: (payload: { channelId: number; userId: number; newState: Partial<TVoiceUserState> }) => void;
	reconcileVoiceChannelUsers: (payload: {
		channelId: number;
		users: Array<{ userId: number; state: TVoiceUserState }>;
	}) => void;
	updateOwnVoiceState: (newState: Partial<TVoiceUserState>) => void;
	setPinnedCard: (pinnedCard: TPinnedCard | undefined) => void;
	addExternalStreamToChannel: (payload: { channelId: number; streamId: number; stream: TExternalStream }) => void;
	updateExternalStreamInChannel: (payload: { channelId: number; streamId: number; stream: TExternalStream }) => void;
	removeExternalStreamFromChannel: (payload: { channelId: number; streamId: number }) => void;
	setPluginCommands: (pluginCommands: TCommandsMapByPlugin) => void;
	addPluginCommand: (command: TCommandInfo) => void;
	removePluginCommand: (payload: { commandName: string }) => void;
	addScreenShareWatcher: (watcherId: number) => void;
	removeScreenShareWatcher: (watcherId: number) => void;
};

const initialState: IServerState = {
	connected: false,
	connecting: false,
	mustChangePassword: false,
	disconnectInfo: undefined,
	serverId: undefined,
	ownUserId: undefined,
	categories: [],
	channels: [],
	emojis: [],
	selectedChannelId: undefined,
	lastTextChannelId: undefined,
	currentVoiceChannelId: undefined,
	voiceSessionReconnectNonce: 0,
	messagesMap: {},
	protectedMessagePrefixCounts: {},
	users: [],
	roles: [],
	publicSettings: undefined,
	info: undefined,
	loadingInfo: false,
	voiceMap: {},
	externalStreamsMap: {},
	ownOptimisticStateExpiresAt: undefined,
	ownVoiceDefaults: {
		micMuted: false,
		soundMuted: false,
		webcamEnabled: false,
		sharingScreen: false,
	},
	pinnedCard: undefined,
	channelPermissions: {},
	readStatesMap: {},
	pluginCommands: {},
	screenShareWatchers: {},
};

const updateById = <T extends { id: number }>(items: T[], id: number, value: Partial<T>): T[] | undefined => {
	const index = items.findIndex((item) => item.id === id);

	if (index === -1) {
		return undefined;
	}

	const nextItems = [...items];

	nextItems[index] = {
		...nextItems[index],
		...value,
	};

	return nextItems;
};

const addById = <T extends { id: number }>(items: T[], item: T): T[] => {
	if (items.some((entry) => entry.id === item.id)) {
		return items;
	}

	return [...items, item];
};

const removeById = <T extends { id: number }>(items: T[], id: number): T[] => {
	return items.filter((item) => item.id !== id);
};

const findVoiceStateForUser = (voiceMap: TVoiceMap, userId: number): TVoiceUserState | undefined => {
	for (const channelState of Object.values(voiceMap)) {
		const userState = channelState?.users[userId];

		if (userState) {
			return userState;
		}
	}

	return undefined;
};

// Optimistic own-voice updates are authoritative for this many milliseconds.
// If the server confirms (via updateVoiceUserState) or a new session starts
// (setInitialData), the expiry is cleared early. Any reconcile that fires after
// the window closes yields to the server's authoritative state instead.
const OPTIMISTIC_VOICE_STATE_TTL_MS = 5_000;

// Bound the live per-channel message tail so long sessions do not accumulate
// the full chat history in memory. User-triggered `loadMore` prepends are kept
// as a protected prefix so later live appends do not immediately evict the
// older history the user explicitly paged in.
const MAX_MESSAGES_PER_CHANNEL = 1000;

const mergeMessages = (existing: TJoinedMessage[], incoming: TJoinedMessage[], prepend: boolean): TJoinedMessage[] => {
	const sortedIncoming = incoming.length > 1 ? [...incoming].sort((a, b) => a.createdAt - b.createdAt) : incoming;

	if (existing.length === 0) {
		return sortedIncoming;
	}

	if (prepend) {
		// Hot path: incoming batch is entirely older than the current head, so
		// straight concat preserves order without re-sorting the full array.
		if (sortedIncoming[sortedIncoming.length - 1].createdAt <= existing[0].createdAt) {
			return [...sortedIncoming, ...existing];
		}
	} else if (sortedIncoming[0].createdAt >= existing[existing.length - 1].createdAt) {
		// Hot path: incoming batch is entirely newer than the current tail.
		return [...existing, ...sortedIncoming];
	}

	// Fallback: timestamps interleave (e.g. backfill mid-buffer). Pay the full
	// sort here only when ordering actually requires it.
	return [...existing, ...sortedIncoming].sort((a, b) => a.createdAt - b.createdAt);
};

const countProtectedMessagePrefix = (
	merged: TJoinedMessage[],
	existing: TJoinedMessage[],
	incoming: TJoinedMessage[],
	protectedPrefixCount: number,
): number => {
	const protectedIds = new Set<number>();

	for (const message of existing.slice(0, protectedPrefixCount)) {
		protectedIds.add(message.id);
	}

	for (const message of incoming) {
		protectedIds.add(message.id);
	}

	let count = 0;

	for (const message of merged) {
		if (!protectedIds.has(message.id)) {
			break;
		}

		count += 1;
	}

	return count;
};

const setProtectedMessagePrefixCount = (
	counts: Record<number, number>,
	channelId: number,
	count: number,
): Record<number, number> => {
	if (count <= 0) {
		if (counts[channelId] === undefined) {
			return counts;
		}

		const nextCounts = { ...counts };
		delete nextCounts[channelId];
		return nextCounts;
	}

	if (counts[channelId] === count) {
		return counts;
	}

	return {
		...counts,
		[channelId]: count,
	};
};

const capChannelMessages = (messages: TJoinedMessage[], protectedPrefixCount: number): TJoinedMessage[] => {
	const normalizedProtectedPrefixCount = Math.min(protectedPrefixCount, messages.length);
	const unprotectedTail = messages.slice(normalizedProtectedPrefixCount);

	if (unprotectedTail.length <= MAX_MESSAGES_PER_CHANNEL) {
		return messages;
	}

	return [
		...messages.slice(0, normalizedProtectedPrefixCount),
		...unprotectedTail.slice(unprotectedTail.length - MAX_MESSAGES_PER_CHANNEL),
	];
};

const mergeOwnVoiceDefaults = (
	currentOwnVoiceDefaults: TVoiceUserState,
	voiceState: Partial<TVoiceUserState>,
): TVoiceUserState => ({
	micMuted: voiceState.micMuted ?? currentOwnVoiceDefaults.micMuted,
	soundMuted: voiceState.soundMuted ?? currentOwnVoiceDefaults.soundMuted,
	webcamEnabled: false,
	sharingScreen: false,
});

const voiceStateUpdateMatchesCurrentState = (
	currentVoiceState: TVoiceUserState,
	newState: Partial<TVoiceUserState>,
) => {
	return (
		(newState.micMuted === undefined || newState.micMuted === currentVoiceState.micMuted) &&
		(newState.soundMuted === undefined || newState.soundMuted === currentVoiceState.soundMuted) &&
		(newState.webcamEnabled === undefined || newState.webcamEnabled === currentVoiceState.webcamEnabled) &&
		(newState.sharingScreen === undefined || newState.sharingScreen === currentVoiceState.sharingScreen)
	);
};

export const useServerStore = create<TServerStore>((set, get) => ({
	...initialState,
	resetState: () => {
		set({
			...initialState,
			info: get().info,
		});
	},
	setConnected: (connected) => {
		set({
			connected,
			connecting: false,
		});
	},
	setConnecting: (connecting) => {
		set({ connecting });
	},
	setMustChangePassword: (mustChangePassword) => {
		set({ mustChangePassword });
	},
	setServerId: (serverId) => {
		set({ serverId });
	},
	setInfo: (info) => {
		set({ info });
	},
	setLoadingInfo: (loadingInfo) => {
		set({ loadingInfo });
	},
	setDisconnectInfo: (disconnectInfo) => {
		set({ disconnectInfo });
	},
	setInitialData: (data) => {
		const ownVoiceState = findVoiceStateForUser(data.voiceMap, data.ownUserId);

		set({
			connected: true,
			mustChangePassword: data.mustChangePassword,
			categories: data.categories,
			channels: data.channels,
			emojis: data.emojis,
			users: data.users,
			roles: data.roles,
			ownUserId: data.ownUserId,
			publicSettings: data.publicSettings,
			voiceMap: data.voiceMap,
			externalStreamsMap: data.externalStreamsMap,
			serverId: data.serverId,
			channelPermissions: data.channelPermissions,
			readStatesMap: data.readStates,
			ownVoiceDefaults: ownVoiceState
				? mergeOwnVoiceDefaults(get().ownVoiceDefaults, ownVoiceState)
				: get().ownVoiceDefaults,
			// A new server session baseline supersedes any pending optimistic state.
			// Clearing here prevents a stale TTL (e.g. from leave-cleanup) from
			// shielding the own user from server-authoritative changes on rejoin.
			ownOptimisticStateExpiresAt: undefined,
			screenShareWatchers: {},
		});
	},
	addMessages: ({ channelId, messages, opts }) => {
		const state = get();
		const existing = state.messagesMap[channelId] ?? [];
		const protectedPrefixCount = state.protectedMessagePrefixCounts[channelId] ?? 0;
		const existingIds = new Set(existing.map((message) => message.id));
		const filtered = messages.filter((message) => !existingIds.has(message.id));

		if (filtered.length === 0) {
			return;
		}

		const prepend = opts?.prepend ?? false;
		let merged = mergeMessages(existing, filtered, prepend);
		const nextProtectedPrefixCount = prepend
			? countProtectedMessagePrefix(merged, existing, filtered, protectedPrefixCount)
			: protectedPrefixCount;

		if (!prepend && merged.length > MAX_MESSAGES_PER_CHANNEL) {
			merged = capChannelMessages(merged, nextProtectedPrefixCount);
		}

		set({
			messagesMap: {
				...state.messagesMap,
				[channelId]: merged,
			},
			protectedMessagePrefixCounts: setProtectedMessagePrefixCount(
				state.protectedMessagePrefixCounts,
				channelId,
				nextProtectedPrefixCount,
			),
		});
	},
	updateMessage: ({ channelId, message }) => {
		const state = get();
		const messages = state.messagesMap[channelId];

		if (!messages) {
			return;
		}

		const messageIndex = messages.findIndex((entry) => entry.id === message.id);

		if (messageIndex === -1) {
			return;
		}

		const nextMessages = [...messages];

		nextMessages[messageIndex] = message;

		set({
			messagesMap: {
				...state.messagesMap,
				[channelId]: nextMessages,
			},
		});
	},
	deleteMessage: ({ channelId, messageId }) => {
		const state = get();
		const messages = state.messagesMap[channelId];

		if (!messages) {
			return;
		}

		const messageIndex = messages.findIndex((message) => message.id === messageId);

		if (messageIndex === -1) {
			return;
		}

		const protectedPrefixCount = state.protectedMessagePrefixCounts[channelId] ?? 0;
		const nextProtectedPrefixCount =
			messageIndex < protectedPrefixCount ? protectedPrefixCount - 1 : protectedPrefixCount;

		set({
			messagesMap: {
				...state.messagesMap,
				[channelId]: messages.filter((message) => message.id !== messageId),
			},
			protectedMessagePrefixCounts: setProtectedMessagePrefixCount(
				state.protectedMessagePrefixCounts,
				channelId,
				nextProtectedPrefixCount,
			),
		});
	},
	setUsers: (users) => {
		set({ users });
	},
	updateUser: ({ userId, user }) => {
		const nextUsers = updateById(get().users, userId, user);

		if (!nextUsers) {
			return;
		}

		set({ users: nextUsers });
	},
	addUser: (user) => {
		const users = get().users;
		const nextUsers = addById(users, user);

		if (nextUsers === users) {
			return;
		}

		set({ users: nextUsers });
	},
	removeUser: ({ userId }) => {
		set({
			users: removeById(get().users, userId),
		});
	},
	setPublicSettings: (publicSettings) => {
		set({ publicSettings });
	},
	setRoles: (roles) => {
		set({ roles });
	},
	updateRole: ({ roleId, role }) => {
		const nextRoles = updateById(get().roles, roleId, role);

		if (!nextRoles) {
			return;
		}

		set({ roles: nextRoles });
	},
	addRole: (role) => {
		const roles = get().roles;
		const nextRoles = addById(roles, role);

		if (nextRoles === roles) {
			return;
		}

		set({ roles: nextRoles });
	},
	removeRole: ({ roleId }) => {
		set({
			roles: removeById(get().roles, roleId),
		});
	},
	setChannels: (channels) => {
		set({ channels });
	},
	updateChannel: ({ channelId, channel }) => {
		const nextChannels = updateById(get().channels, channelId, channel);

		if (!nextChannels) {
			return;
		}

		set({ channels: nextChannels });
	},
	addChannel: (channel) => {
		const channels = get().channels;
		const nextChannels = addById(channels, channel);

		if (nextChannels === channels) {
			return;
		}

		set({ channels: nextChannels });
	},
	removeChannel: ({ channelId }) => {
		set({
			channels: removeById(get().channels, channelId),
		});
	},
	setSelectedChannelId: (channelId) => {
		if (channelId === undefined) {
			set({ selectedChannelId: undefined });
			return;
		}

		const state = get();
		const selectedChannel = state.channels.find((channel) => channel.id === channelId);

		set({
			selectedChannelId: channelId,
			lastTextChannelId: selectedChannel?.type === ChannelType.TEXT ? channelId : state.lastTextChannelId,
			readStatesMap: {
				...state.readStatesMap,
				[channelId]: 0,
			},
		});
	},
	setCurrentVoiceChannelId: (channelId) => {
		set({ currentVoiceChannelId: channelId });
	},
	bumpVoiceSessionReconnectNonce: () => {
		set((state) => ({ voiceSessionReconnectNonce: state.voiceSessionReconnectNonce + 1 }));
	},
	setChannelPermissions: (channelPermissions) => {
		set({ channelPermissions });
	},
	setChannelReadState: ({ channelId, count }) => {
		set({
			readStatesMap: {
				...get().readStatesMap,
				[channelId]: count,
			},
		});
	},
	setEmojis: (emojis) => {
		set({ emojis });
	},
	updateEmoji: ({ emojiId, emoji }) => {
		const nextEmojis = updateById(get().emojis, emojiId, emoji);

		if (!nextEmojis) {
			return;
		}

		set({ emojis: nextEmojis });
	},
	addEmoji: (emoji) => {
		const emojis = get().emojis;
		const nextEmojis = addById(emojis, emoji);

		if (nextEmojis === emojis) {
			return;
		}

		set({ emojis: nextEmojis });
	},
	removeEmoji: ({ emojiId }) => {
		set({
			emojis: removeById(get().emojis, emojiId),
		});
	},
	setCategories: (categories) => {
		set({ categories });
	},
	addCategory: (category) => {
		const categories = get().categories;
		const nextCategories = addById(categories, category);

		if (nextCategories === categories) {
			return;
		}

		set({ categories: nextCategories });
	},
	updateCategory: ({ categoryId, category }) => {
		const nextCategories = updateById(get().categories, categoryId, category);

		if (!nextCategories) {
			return;
		}

		set({ categories: nextCategories });
	},
	removeCategory: ({ categoryId }) => {
		set({
			categories: removeById(get().categories, categoryId),
		});
	},
	addUserToVoiceChannel: ({ channelId, userId, state: userState }) => {
		const storeState = get();
		const channelState = storeState.voiceMap[channelId] ?? { users: {} };

		set({
			voiceMap: {
				...storeState.voiceMap,
				[channelId]: {
					...channelState,
					users: {
						...channelState.users,
						[userId]: userState,
					},
				},
			},
			// Mirror durable own-user preferences from server-confirmed state,
			// but keep live in-call state derived from voiceMap.
			ownVoiceDefaults:
				storeState.ownUserId === userId
					? mergeOwnVoiceDefaults(storeState.ownVoiceDefaults, userState)
					: storeState.ownVoiceDefaults,
		});
	},
	removeUserFromVoiceChannel: ({ channelId, userId }) => {
		const storeState = get();
		const channelState = storeState.voiceMap[channelId];

		if (!channelState) {
			return;
		}

		const nextUsers = { ...channelState.users };

		delete nextUsers[userId];

		set({
			voiceMap: {
				...storeState.voiceMap,
				[channelId]: {
					...channelState,
					users: nextUsers,
				},
			},
		});
	},
	updateVoiceUserState: ({ channelId, userId, newState }) => {
		const storeState = get();
		const channelState = storeState.voiceMap[channelId];
		const currentVoiceState = channelState?.users[userId];

		if (!channelState || !currentVoiceState) {
			return;
		}

		const isOwnUser = storeState.ownUserId === userId;
		const isOptimisticStatePending =
			isOwnUser &&
			storeState.ownOptimisticStateExpiresAt !== undefined &&
			Date.now() < storeState.ownOptimisticStateExpiresAt;
		const shouldPreserveOwnOptimisticState =
			isOptimisticStatePending && !voiceStateUpdateMatchesCurrentState(currentVoiceState, newState);
		const nextVoiceState = shouldPreserveOwnOptimisticState
			? currentVoiceState
			: {
					...currentVoiceState,
					...newState,
				};

		set({
			voiceMap: {
				...storeState.voiceMap,
				[channelId]: {
					...channelState,
					users: {
						...channelState.users,
						[userId]: nextVoiceState,
					},
				},
			},
			// Server updates remain authoritative for own-user preferences too.
			ownVoiceDefaults: isOwnUser
				? mergeOwnVoiceDefaults(storeState.ownVoiceDefaults, nextVoiceState)
				: storeState.ownVoiceDefaults,
			// Matching server confirmation clears the optimistic-pending window.
			...(isOwnUser && !shouldPreserveOwnOptimisticState ? { ownOptimisticStateExpiresAt: undefined } : undefined),
			...(isOwnUser && !shouldPreserveOwnOptimisticState && newState.sharingScreen === false
				? { screenShareWatchers: {} }
				: undefined),
		});
	},
	reconcileVoiceChannelUsers: ({ channelId, users }) => {
		const storeState = get();
		const { ownUserId, ownOptimisticStateExpiresAt } = storeState;
		const existingChannelState = storeState.voiceMap[channelId];

		// Replace the channel user list with the server's authoritative snapshot.
		// For the own user, preserve local state only while an optimistic update is
		// still within its pending window (i.e. the TRPC call hasn't been confirmed
		// yet). Once the TTL expires — or the server has already confirmed via
		// updateVoiceUserState / setInitialData — server state wins. This ensures
		// admin mutes and permission changes applied during a disconnect are not
		// silently discarded on rejoin.
		const isOptimisticStatePending =
			ownOptimisticStateExpiresAt !== undefined && Date.now() < ownOptimisticStateExpiresAt;
		const newUsers: Record<number, TVoiceUserState> = {};

		for (const { userId, state } of users) {
			const existingState = existingChannelState?.users[userId];
			newUsers[userId] = userId === ownUserId && existingState && isOptimisticStatePending ? existingState : state;
		}

		set({
			voiceMap: {
				...storeState.voiceMap,
				[channelId]: {
					...existingChannelState,
					users: newUsers,
				},
			},
			// If the TTL had already elapsed, clear the stale sentinel so it doesn't
			// linger in the store until the next setInitialData or confirmation.
			...(!isOptimisticStatePending && ownOptimisticStateExpiresAt !== undefined
				? { ownOptimisticStateExpiresAt: undefined }
				: undefined),
		});
	},
	updateOwnVoiceState: (newState) => {
		const storeState = get();
		const { currentVoiceChannelId, ownUserId } = storeState;
		const ownChannelId = currentVoiceChannelId;
		const currentChannelState = ownChannelId !== undefined ? storeState.voiceMap[ownChannelId] : undefined;
		const currentOwnVoiceState =
			currentChannelState && ownUserId !== undefined ? currentChannelState.users[ownUserId] : undefined;

		const nextExpiresAt = Date.now() + OPTIMISTIC_VOICE_STATE_TTL_MS;
		const resetScreenShareWatchers = newState.sharingScreen !== undefined ? { screenShareWatchers: {} } : undefined;

		if (ownChannelId !== undefined && currentChannelState && ownUserId !== undefined && currentOwnVoiceState) {
			set({
				voiceMap: {
					...storeState.voiceMap,
					[ownChannelId]: {
						...currentChannelState,
						users: {
							...currentChannelState.users,
							[ownUserId]: {
								...currentOwnVoiceState,
								...newState,
							},
						},
					},
				},
				// When already in voice, optimistic local toggles patch the live own-user
				// entry directly and also persist the off-channel defaults.
				ownVoiceDefaults: mergeOwnVoiceDefaults(storeState.ownVoiceDefaults, newState),
				ownOptimisticStateExpiresAt: nextExpiresAt,
				...resetScreenShareWatchers,
			});
			return;
		}

		set({
			ownVoiceDefaults: mergeOwnVoiceDefaults(storeState.ownVoiceDefaults, newState),
			ownOptimisticStateExpiresAt: nextExpiresAt,
			...resetScreenShareWatchers,
		});
	},
	setPinnedCard: (pinnedCard) => {
		set({ pinnedCard });
	},
	addExternalStreamToChannel: ({ channelId, streamId, stream }) => {
		const storeState = get();
		const channelStreams = storeState.externalStreamsMap[channelId] ?? {};

		set({
			externalStreamsMap: {
				...storeState.externalStreamsMap,
				[channelId]: {
					...channelStreams,
					[streamId]: stream,
				},
			},
		});
	},
	updateExternalStreamInChannel: ({ channelId, streamId, stream }) => {
		const storeState = get();
		const channelStreams = storeState.externalStreamsMap[channelId];

		if (!channelStreams?.[streamId]) {
			return;
		}

		set({
			externalStreamsMap: {
				...storeState.externalStreamsMap,
				[channelId]: {
					...channelStreams,
					[streamId]: stream,
				},
			},
		});
	},
	removeExternalStreamFromChannel: ({ channelId, streamId }) => {
		const storeState = get();
		const channelStreams = storeState.externalStreamsMap[channelId];

		if (!channelStreams) {
			return;
		}

		const nextChannelStreams = { ...channelStreams };

		delete nextChannelStreams[streamId];

		set({
			externalStreamsMap: {
				...storeState.externalStreamsMap,
				[channelId]: nextChannelStreams,
			},
		});
	},
	setPluginCommands: (pluginCommands) => {
		set({ pluginCommands });
	},
	addPluginCommand: (command) => {
		const storeState = get();
		const existingCommands = storeState.pluginCommands[command.pluginId] ?? [];

		if (existingCommands.some((entry) => entry.name === command.name)) {
			return;
		}

		set({
			pluginCommands: {
				...storeState.pluginCommands,
				[command.pluginId]: [...existingCommands, command],
			},
		});
	},
	removePluginCommand: ({ commandName }) => {
		const pluginCommands = get().pluginCommands;
		const nextPluginCommands = Object.fromEntries(
			Object.entries(pluginCommands).map(([pluginId, commands]) => [
				pluginId,
				commands.filter((command) => command.name !== commandName),
			]),
		);

		set({
			pluginCommands: nextPluginCommands,
		});
	},
	addScreenShareWatcher: (watcherId) => {
		const screenShareWatchers = get().screenShareWatchers;

		if (screenShareWatchers[watcherId]) {
			return;
		}

		set({
			screenShareWatchers: {
				...screenShareWatchers,
				[watcherId]: true,
			},
		});
	},
	removeScreenShareWatcher: (watcherId) => {
		const screenShareWatchers = get().screenShareWatchers;

		if (!screenShareWatchers[watcherId]) {
			return;
		}

		const nextScreenShareWatchers = { ...screenShareWatchers };

		delete nextScreenShareWatchers[watcherId];

		set({ screenShareWatchers: nextScreenShareWatchers });
	},
}));
