import {
	Permission,
	type TChannel,
	type TChannelUserPermissionsMap,
	type TCommandInfo,
	type TCommandsMapByPlugin,
	type TExternalStream,
	type TJoinedEmoji,
	type TJoinedMessage,
	type TJoinedPublicUser,
	type TJoinedRole,
	type TPublicServerSettings,
	type TVoiceUserState,
	UserStatus,
} from '@sharkord/shared';
import { getEffects } from './adapters';
import { channelByIdSelector, channelReadStateByIdSelector, selectedChannelIdSelector } from './channels-selectors';
import {
	addMessagesToStore,
	addTypingUserToStore,
	deleteMessageFromStore,
	updateMessageInStore,
} from './message-store';
import { getTRPCClient } from './trpc';
import { rolesSelector } from './roles-selectors';
import { useServerStore } from './server-store';
import { ownUserSelector, userByIdSelector } from './users-selectors';

const setPluginCommands = (pluginCommands: TCommandsMapByPlugin) => {
	useServerStore.getState().setPluginCommands(pluginCommands);
	getEffects()?.onPluginCommandsChanged?.(pluginCommands);
};

const addPluginCommand = (command: TCommandInfo) => {
	useServerStore.getState().addPluginCommand(command);
	getEffects()?.onCommandReceived?.(command);
};

const setPublicServerSettings = (publicSettings: TPublicServerSettings | undefined) => {
	useServerStore.getState().setPublicSettings(publicSettings);
};

const addUser = (user: TJoinedPublicUser) => {
	useServerStore.getState().addUser(user);
};

const removeUser = (userId: number) => {
	useServerStore.getState().removeUser({ userId });
};

const updateUser = (userId: number, user: Partial<TJoinedPublicUser>) => {
	useServerStore.getState().updateUser({ userId, user });
};

const handleUserJoin = (user: TJoinedPublicUser) => {
	const state = useServerStore.getState();
	const foundUser = userByIdSelector(state, user.id);

	if (foundUser) {
		updateUser(user.id, { ...user, status: UserStatus.ONLINE });
		return;
	}

	addUser(user);
};

const updateRole = (roleId: number, role: Partial<TJoinedRole>) => {
	useServerStore.getState().updateRole({ roleId, role });
};

const addRole = (role: TJoinedRole) => {
	useServerStore.getState().addRole(role);
};

const removeRole = (roleId: number) => {
	useServerStore.getState().removeRole({ roleId });
};

const addChannel = (channel: TChannel) => {
	useServerStore.getState().addChannel(channel);
};

const updateChannel = (channelId: number, channel: Partial<TChannel>) => {
	useServerStore.getState().updateChannel({ channelId, channel });
};

const removeChannel = (channelId: number) => {
	useServerStore.getState().removeChannel({ channelId });
};

const setChannelPermissions = (permissions: TChannelUserPermissionsMap) => {
	useServerStore.getState().setChannelPermissions(permissions);

	const state = useServerStore.getState();
	const selectedChannel = selectedChannelIdSelector(state);

	if (!selectedChannel) {
		return;
	}

	const channel = channelByIdSelector(state, selectedChannel);

	if (!channel?.private) {
		return;
	}

	const canViewChannel = permissions[selectedChannel]?.permissions.VIEW_CHANNEL === true;

	if (!canViewChannel) {
		useServerStore.getState().setSelectedChannelId(undefined);
	}
};

const setChannelReadState = (
	channelId: number,
	payload: {
		count?: number;
		delta?: number;
	},
) => {
	const state = useServerStore.getState();
	const selectedChannel = selectedChannelIdSelector(state);
	const currentCount = channelReadStateByIdSelector(state, channelId);

	let nextCount: number | undefined;

	if (typeof payload.count === 'number') {
		nextCount = payload.count;
	} else if (typeof payload.delta === 'number') {
		nextCount = Math.max(0, currentCount + payload.delta);
	}

	useServerStore.getState().setChannelReadState({
		channelId,
		count: selectedChannel === channelId ? 0 : nextCount,
	});
};

const addEmoji = (emoji: TJoinedEmoji) => {
	useServerStore.getState().addEmoji(emoji);
};

const updateEmoji = (emojiId: number, emoji: Partial<TJoinedEmoji>) => {
	useServerStore.getState().updateEmoji({ emojiId, emoji });
};

const removeEmoji = (emojiId: number) => {
	useServerStore.getState().removeEmoji({ emojiId });
};

const addCategory = (category: import('@sharkord/shared').TCategory) => {
	useServerStore.getState().addCategory(category);
};

const updateCategory = (categoryId: number, category: Partial<import('@sharkord/shared').TCategory>) => {
	useServerStore.getState().updateCategory({ categoryId, category });
};

const removeCategory = (categoryId: number) => {
	useServerStore.getState().removeCategory({ categoryId });
};

const addUserToVoiceChannel = (userId: number, channelId: number, state: TVoiceUserState) => {
	useServerStore.getState().addUserToVoiceChannel({ channelId, state, userId });
};

const removeUserFromVoiceChannel = (userId: number, channelId: number) => {
	useServerStore.getState().removeUserFromVoiceChannel({ channelId, userId });

	const pinnedCard = useServerStore.getState().pinnedCard;

	if (pinnedCard?.id === `user-${userId}` || pinnedCard?.id === `screen-share-${userId}`) {
		useServerStore.getState().setPinnedCard(undefined);
	}
};

const updateVoiceUserState = (userId: number, channelId: number, newState: Partial<TVoiceUserState>) => {
	useServerStore.getState().updateVoiceUserState({ channelId, newState, userId });

	if (newState.sharingScreen === false) {
		const pinnedCard = useServerStore.getState().pinnedCard;

		if (pinnedCard?.id === `screen-share-${userId}`) {
			useServerStore.getState().setPinnedCard(undefined);
		}
	}
};

const addExternalStreamToVoiceChannel = (channelId: number, streamId: number, stream: TExternalStream) => {
	useServerStore.getState().addExternalStreamToChannel({ channelId, stream, streamId });
};

const updateExternalStreamInVoiceChannel = (channelId: number, streamId: number, stream: TExternalStream) => {
	useServerStore.getState().updateExternalStreamInChannel({ channelId, stream, streamId });
};

const removeExternalStreamFromVoiceChannel = (channelId: number, streamId: number) => {
	useServerStore.getState().removeExternalStreamFromChannel({ channelId, streamId });

	const pinnedCard = useServerStore.getState().pinnedCard;

	if (pinnedCard?.id === `external-stream-${streamId}`) {
		useServerStore.getState().setPinnedCard(undefined);
	}
};

const subscribeToServer = () => {
	const trpc = getTRPCClient();

	const onSettingsUpdateSub = trpc.others.onServerSettingsUpdate.subscribe(undefined, {
		onData: (settings: TPublicServerSettings) => setPublicServerSettings(settings),
		onError: (error) => console.error('onSettingsUpdate subscription error:', error),
	});

	return () => {
		onSettingsUpdateSub.unsubscribe();
	};
};

const subscribeToChannels = () => {
	const trpc = getTRPCClient();

	const onChannelCreateSub = trpc.channels.onCreate.subscribe(undefined, {
		onData: (channel) => addChannel(channel),
		onError: (error) => console.error('onChannelCreate subscription error:', error),
	});

	const onChannelDeleteSub = trpc.channels.onDelete.subscribe(undefined, {
		onData: (channelId) => removeChannel(channelId),
		onError: (error) => console.error('onChannelDelete subscription error:', error),
	});

	const onChannelUpdateSub = trpc.channels.onUpdate.subscribe(undefined, {
		onData: (channel) => updateChannel(channel.id, channel),
		onError: (error) => console.error('onChannelUpdate subscription error:', error),
	});

	const onChannelPermissionsUpdateSub = trpc.channels.onPermissionsUpdate.subscribe(undefined, {
		onData: (data) => setChannelPermissions(data),
		onError: (error) => console.error('onChannelPermissionsUpdate subscription error:', error),
	});

	const onChannelReadStatesUpdateSub = trpc.channels.onReadStateUpdate.subscribe(undefined, {
		onData: (data) => setChannelReadState(data.channelId, data),
		onError: (error) => console.error('onChannelReadStateUpdate subscription error:', error),
	});

	const onChannelReadStatesDeltaSub = trpc.channels.onReadStateDelta.subscribe(undefined, {
		onData: (data) => setChannelReadState(data.channelId, data),
		onError: (error) => console.error('onChannelReadStateDelta subscription error:', error),
	});

	return () => {
		onChannelCreateSub.unsubscribe();
		onChannelDeleteSub.unsubscribe();
		onChannelUpdateSub.unsubscribe();
		onChannelPermissionsUpdateSub.unsubscribe();
		onChannelReadStatesUpdateSub.unsubscribe();
		onChannelReadStatesDeltaSub.unsubscribe();
	};
};

const subscribeToEmojis = () => {
	const trpc = getTRPCClient();

	const onEmojiCreateSub = trpc.emojis.onCreate.subscribe(undefined, {
		onData: (emoji: TJoinedEmoji) => addEmoji(emoji),
		onError: (error) => console.error('onEmojiCreate subscription error:', error),
	});

	const onEmojiDeleteSub = trpc.emojis.onDelete.subscribe(undefined, {
		onData: (emojiId: number) => removeEmoji(emojiId),
		onError: (error) => console.error('onEmojiDelete subscription error:', error),
	});

	const onEmojiUpdateSub = trpc.emojis.onUpdate.subscribe(undefined, {
		onData: (emoji: TJoinedEmoji) => updateEmoji(emoji.id, emoji),
		onError: (error) => console.error('onEmojiUpdate subscription error:', error),
	});

	return () => {
		onEmojiCreateSub.unsubscribe();
		onEmojiDeleteSub.unsubscribe();
		onEmojiUpdateSub.unsubscribe();
	};
};

const subscribeToRoles = () => {
	const trpc = getTRPCClient();

	const onRoleCreateSub = trpc.roles.onCreate.subscribe(undefined, {
		onData: (role: TJoinedRole) => addRole(role),
		onError: (error) => console.error('onRoleCreate subscription error:', error),
	});

	const onRoleDeleteSub = trpc.roles.onDelete.subscribe(undefined, {
		onData: (roleId: number) => removeRole(roleId),
		onError: (error) => console.error('onRoleDelete subscription error:', error),
	});

	const onRoleUpdateSub = trpc.roles.onUpdate.subscribe(undefined, {
		onData: (role: TJoinedRole) => updateRole(role.id, role),
		onError: (error) => console.error('onRoleUpdate subscription error:', error),
	});

	return () => {
		onRoleCreateSub.unsubscribe();
		onRoleDeleteSub.unsubscribe();
		onRoleUpdateSub.unsubscribe();
	};
};

const subscribeToUsers = ({ canSubscribeToDelete = false } = {}) => {
	const trpc = getTRPCClient();

	const onUserJoinSub = trpc.users.onJoin.subscribe(undefined, {
		onData: (user: TJoinedPublicUser) => {
			handleUserJoin(user);
		},
		onError: (error) => console.error('onUserJoin subscription error:', error),
	});

	const onUserCreateSub = trpc.users.onCreate.subscribe(undefined, {
		onData: (user: TJoinedPublicUser) => {
			addUser(user);
		},
		onError: (error) => console.error('onUserCreate subscription error:', error),
	});

	const onUserLeaveSub = trpc.users.onLeave.subscribe(undefined, {
		onData: (userId: number) => {
			updateUser(userId, { status: UserStatus.OFFLINE });
		},
		onError: (error) => console.error('onUserLeave subscription error:', error),
	});

	const onUserUpdateSub = trpc.users.onUpdate.subscribe(undefined, {
		onData: (user: TJoinedPublicUser) => {
			updateUser(user.id, user);
		},
		onError: (error) => console.error('onUserUpdate subscription error:', error),
	});

	const onUserDeleteSub = canSubscribeToDelete
		? trpc.users.onDelete.subscribe(undefined, {
				onData: (userId: number) => {
					removeUser(userId);
				},
				onError: (error) => console.error('onUserDelete subscription error:', error),
			})
		: null;

	return () => {
		onUserJoinSub.unsubscribe();
		onUserCreateSub.unsubscribe();
		onUserLeaveSub.unsubscribe();
		onUserUpdateSub.unsubscribe();
		onUserDeleteSub?.unsubscribe();
	};
};

const subscribeToMessages = () => {
	const trpc = getTRPCClient();

	const onMessageSub = trpc.messages.onNew.subscribe(undefined, {
		onData: (message: TJoinedMessage) => addMessagesToStore(message.channelId, [message], {}, true),
		onError: (error) => console.error('onMessage subscription error:', error),
	});

	const onMessageUpdateSub = trpc.messages.onUpdate.subscribe(undefined, {
		onData: (message: TJoinedMessage) => updateMessageInStore(message.channelId, message),
		onError: (error) => console.error('onMessageUpdate subscription error:', error),
	});

	const onMessageDeleteSub = trpc.messages.onDelete.subscribe(undefined, {
		onData: ({ channelId, messageId }) => deleteMessageFromStore(channelId, messageId),
		onError: (error) => console.error('onMessageDelete subscription error:', error),
	});

	const onMessageTypingSub = trpc.messages.onTyping.subscribe(undefined, {
		onData: ({ channelId, userId }) => addTypingUserToStore(channelId, userId),
		onError: (error) => console.error('onMessageTyping subscription error:', error),
	});

	return () => {
		onMessageSub.unsubscribe();
		onMessageUpdateSub.unsubscribe();
		onMessageDeleteSub.unsubscribe();
		onMessageTypingSub.unsubscribe();
	};
};

const subscribeToVoice = () => {
	const trpc = getTRPCClient();

	const onUserJoinVoiceSub = trpc.voice.onJoin.subscribe(undefined, {
		onData: ({ channelId, state, userId }) => addUserToVoiceChannel(userId, channelId, state),
		onError: (error) => console.error('onUserJoinVoice subscription error:', error),
	});

	const onUserLeaveVoiceSub = trpc.voice.onLeave.subscribe(undefined, {
		onData: ({ channelId, userId }) => removeUserFromVoiceChannel(userId, channelId),
		onError: (error) => console.error('onUserLeaveVoice subscription error:', error),
	});

	const onUserUpdateVoiceSub = trpc.voice.onUpdateState.subscribe(undefined, {
		onData: ({ channelId, state, userId }) => updateVoiceUserState(userId, channelId, state),
		onError: (error) => console.error('onUserUpdateVoice subscription error:', error),
	});

	const onVoiceAddExternalStreamSub = trpc.voice.onAddExternalStream.subscribe(undefined, {
		onData: ({ channelId, stream, streamId }) => {
			addExternalStreamToVoiceChannel(channelId, streamId, stream);
		},
		onError: (error) => console.error('onVoiceAddExternalStream subscription error:', error),
	});

	const onVoiceUpdateExternalStreamSub = trpc.voice.onUpdateExternalStream.subscribe(undefined, {
		onData: ({ channelId, stream, streamId }) => {
			updateExternalStreamInVoiceChannel(channelId, streamId, stream);
		},
		onError: (error) => console.error('onVoiceUpdateExternalStream subscription error:', error),
	});

	const onVoiceRemoveExternalStreamSub = trpc.voice.onRemoveExternalStream.subscribe(undefined, {
		onData: ({ channelId, streamId }) => removeExternalStreamFromVoiceChannel(channelId, streamId),
		onError: (error) => console.error('onVoiceRemoveExternalStream subscription error:', error),
	});

	return () => {
		onUserJoinVoiceSub.unsubscribe();
		onUserLeaveVoiceSub.unsubscribe();
		onUserUpdateVoiceSub.unsubscribe();
		onVoiceAddExternalStreamSub.unsubscribe();
		onVoiceUpdateExternalStreamSub.unsubscribe();
		onVoiceRemoveExternalStreamSub.unsubscribe();
	};
};

const subscribeToCategories = () => {
	const trpc = getTRPCClient();

	const onCategoryCreateSub = trpc.categories.onCreate.subscribe(undefined, {
		onData: (category) => addCategory(category),
		onError: (error) => console.error('onCategoryCreate subscription error:', error),
	});

	const onCategoryDeleteSub = trpc.categories.onDelete.subscribe(undefined, {
		onData: (categoryId) => removeCategory(categoryId),
		onError: (error) => console.error('onCategoryDelete subscription error:', error),
	});

	const onCategoryUpdateSub = trpc.categories.onUpdate.subscribe(undefined, {
		onData: (category) => updateCategory(category.id, category),
		onError: (error) => console.error('onCategoryUpdate subscription error:', error),
	});

	return () => {
		onCategoryCreateSub.unsubscribe();
		onCategoryDeleteSub.unsubscribe();
		onCategoryUpdateSub.unsubscribe();
	};
};

const subscribeToPlugins = () => {
	const trpc = getTRPCClient();

	const onCommandsChangeSub = trpc.plugins.onCommandsChange.subscribe(undefined, {
		onData: (data) => {
			setPluginCommands(data);

			Object.values(data)
				.flat()
				.forEach((command) => {
					addPluginCommand(command);
				});
		},
		onError: (error) => console.error('onCommandsChange subscription error:', error),
	});

	return () => {
		onCommandsChangeSub.unsubscribe();
	};
};

const initSubscriptions = () => {
	const state = useServerStore.getState();
	const ownUser = ownUserSelector(state);
	const roles = rolesSelector(state);
	const ownRoleIds = new Set(ownUser?.roleIds ?? []);

	const canSubscribeToPluginCommands = roles.some((role) => {
		if (!ownRoleIds.has(role.id)) {
			return false;
		}

		return role.permissions.includes(Permission.EXECUTE_PLUGIN_COMMANDS);
	});

	const canSubscribeToUserDelete = roles.some((role) => {
		if (!ownRoleIds.has(role.id)) {
			return false;
		}

		return role.permissions.includes(Permission.MANAGE_USERS);
	});

	const subscriptors = [
		subscribeToChannels,
		subscribeToServer,
		subscribeToEmojis,
		subscribeToRoles,
		() => subscribeToUsers({ canSubscribeToDelete: canSubscribeToUserDelete }),
		subscribeToMessages,
		subscribeToVoice,
		subscribeToCategories,
	];

	if (canSubscribeToPluginCommands) {
		subscriptors.push(subscribeToPlugins);
	}

	const unsubscribes = subscriptors.map((subscriptor) => subscriptor());

	return () => {
		unsubscribes.forEach((unsubscribe) => unsubscribe());
	};
};

export { initSubscriptions, setPluginCommands, setPublicServerSettings };
