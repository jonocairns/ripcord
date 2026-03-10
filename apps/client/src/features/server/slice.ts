import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
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
  TVoiceUserState
} from '@sharkord/shared';
import { create } from 'zustand';
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
  currentVoiceChannelId: number | undefined;
  messagesMap: TMessagesMap;
  users: TJoinedPublicUser[];
  roles: TJoinedRole[];
  publicSettings: TPublicServerSettings | undefined;
  info: TServerInfo | undefined;
  loadingInfo: boolean;
  typingMap: {
    [channelId: number]: number[];
  };
  voiceMap: TVoiceMap;
  externalStreamsMap: TExternalStreamsMap;
  ownVoiceState: TVoiceUserState;
  pinnedCard: TPinnedCard | undefined;
  channelPermissions: TChannelUserPermissionsMap;
  readStatesMap: {
    [channelId: number]: number | undefined;
  };
  pluginCommands: TCommandsMapByPlugin;
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
  addMessages: (payload: {
    channelId: number;
    messages: TJoinedMessage[];
    opts?: { prepend?: boolean };
  }) => void;
  updateMessage: (payload: {
    channelId: number;
    message: TJoinedMessage;
  }) => void;
  deleteMessage: (payload: { channelId: number; messageId: number }) => void;
  clearTypingUsers: (channelId: number) => void;
  addTypingUser: (payload: { channelId: number; userId: number }) => void;
  removeTypingUser: (payload: { channelId: number; userId: number }) => void;
  setUsers: (users: TJoinedPublicUser[]) => void;
  updateUser: (payload: {
    userId: number;
    user: Partial<TJoinedPublicUser>;
  }) => void;
  addUser: (user: TJoinedPublicUser) => void;
  removeUser: (payload: { userId: number }) => void;
  setPublicSettings: (
    publicSettings: TPublicServerSettings | undefined
  ) => void;
  setRoles: (roles: TJoinedRole[]) => void;
  updateRole: (payload: { roleId: number; role: Partial<TJoinedRole> }) => void;
  addRole: (role: TJoinedRole) => void;
  removeRole: (payload: { roleId: number }) => void;
  setChannels: (channels: TChannel[]) => void;
  updateChannel: (payload: {
    channelId: number;
    channel: Partial<TChannel>;
  }) => void;
  addChannel: (channel: TChannel) => void;
  removeChannel: (payload: { channelId: number }) => void;
  setSelectedChannelId: (channelId: number | undefined) => void;
  setCurrentVoiceChannelId: (channelId: number | undefined) => void;
  setChannelPermissions: (
    channelPermissions: TChannelUserPermissionsMap
  ) => void;
  setChannelReadState: (payload: {
    channelId: number;
    count: number | undefined;
  }) => void;
  setEmojis: (emojis: TJoinedEmoji[]) => void;
  updateEmoji: (payload: {
    emojiId: number;
    emoji: Partial<TJoinedEmoji>;
  }) => void;
  addEmoji: (emoji: TJoinedEmoji) => void;
  removeEmoji: (payload: { emojiId: number }) => void;
  setCategories: (categories: TCategory[]) => void;
  addCategory: (category: TCategory) => void;
  updateCategory: (payload: {
    categoryId: number;
    category: Partial<TCategory>;
  }) => void;
  removeCategory: (payload: { categoryId: number }) => void;
  addUserToVoiceChannel: (payload: {
    channelId: number;
    userId: number;
    state: TVoiceUserState;
  }) => void;
  removeUserFromVoiceChannel: (payload: {
    channelId: number;
    userId: number;
  }) => void;
  updateVoiceUserState: (payload: {
    channelId: number;
    userId: number;
    newState: Partial<TVoiceUserState>;
  }) => void;
  updateOwnVoiceState: (newState: Partial<TVoiceUserState>) => void;
  setPinnedCard: (pinnedCard: TPinnedCard | undefined) => void;
  addExternalStreamToChannel: (payload: {
    channelId: number;
    streamId: number;
    stream: TExternalStream;
  }) => void;
  updateExternalStreamInChannel: (payload: {
    channelId: number;
    streamId: number;
    stream: TExternalStream;
  }) => void;
  removeExternalStreamFromChannel: (payload: {
    channelId: number;
    streamId: number;
  }) => void;
  setPluginCommands: (pluginCommands: TCommandsMapByPlugin) => void;
  addPluginCommand: (command: TCommandInfo) => void;
  removePluginCommand: (payload: { commandName: string }) => void;
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
  currentVoiceChannelId: undefined,
  messagesMap: {},
  users: [],
  roles: [],
  publicSettings: undefined,
  info: undefined,
  loadingInfo: false,
  typingMap: {},
  voiceMap: {},
  externalStreamsMap: {},
  ownVoiceState: {
    micMuted: false,
    soundMuted: false,
    webcamEnabled: false,
    sharingScreen: false
  },
  pinnedCard: undefined,
  channelPermissions: {},
  readStatesMap: {},
  pluginCommands: {}
};

const updateById = <T extends { id: number }>(
  items: T[],
  id: number,
  value: Partial<T>
): T[] | undefined => {
  const index = items.findIndex((item) => item.id === id);

  if (index === -1) {
    return undefined;
  }

  const nextItems = [...items];

  nextItems[index] = {
    ...nextItems[index],
    ...value
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

export const useServerStore = create<TServerStore>((set, get) => ({
  ...initialState,
  resetState: () => {
    set({
      ...initialState,
      info: get().info
    });
  },
  setConnected: (connected) => {
    set({
      connected,
      connecting: false
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
      readStatesMap: data.readStates
    });
  },
  addMessages: ({ channelId, messages, opts }) => {
    const state = get();
    const existing = state.messagesMap[channelId] ?? [];
    const existingIds = new Set(existing.map((message) => message.id));
    const filtered = messages.filter((message) => !existingIds.has(message.id));

    if (filtered.length === 0) {
      return;
    }

    const merged = opts?.prepend
      ? [...filtered, ...existing]
      : [...existing, ...filtered];

    set({
      messagesMap: {
        ...state.messagesMap,
        [channelId]: [...merged].sort((a, b) => a.createdAt - b.createdAt)
      }
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
        [channelId]: nextMessages
      }
    });
  },
  deleteMessage: ({ channelId, messageId }) => {
    const state = get();
    const messages = state.messagesMap[channelId];

    if (!messages) {
      return;
    }

    set({
      messagesMap: {
        ...state.messagesMap,
        [channelId]: messages.filter((message) => message.id !== messageId)
      }
    });
  },
  clearTypingUsers: (channelId) => {
    const state = get();

    if (!state.typingMap[channelId]) {
      return;
    }

    const nextTypingMap = { ...state.typingMap };

    delete nextTypingMap[channelId];

    set({ typingMap: nextTypingMap });
  },
  addTypingUser: ({ channelId, userId }) => {
    const state = get();
    const typingUsers = state.typingMap[channelId] ?? [];

    if (typingUsers.includes(userId)) {
      return;
    }

    set({
      typingMap: {
        ...state.typingMap,
        [channelId]: [...typingUsers, userId]
      }
    });
  },
  removeTypingUser: ({ channelId, userId }) => {
    const state = get();
    const typingUsers = state.typingMap[channelId] ?? [];

    set({
      typingMap: {
        ...state.typingMap,
        [channelId]: typingUsers.filter((id) => id !== userId)
      }
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
      users: removeById(get().users, userId)
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
      roles: removeById(get().roles, roleId)
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
      channels: removeById(get().channels, channelId)
    });
  },
  setSelectedChannelId: (channelId) => {
    if (channelId === undefined) {
      set({ selectedChannelId: undefined });
      return;
    }

    const state = get();

    set({
      selectedChannelId: channelId,
      readStatesMap: {
        ...state.readStatesMap,
        [channelId]: 0
      }
    });
  },
  setCurrentVoiceChannelId: (channelId) => {
    set({ currentVoiceChannelId: channelId });
  },
  setChannelPermissions: (channelPermissions) => {
    set({ channelPermissions });
  },
  setChannelReadState: ({ channelId, count }) => {
    set({
      readStatesMap: {
        ...get().readStatesMap,
        [channelId]: count
      }
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
      emojis: removeById(get().emojis, emojiId)
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
      categories: removeById(get().categories, categoryId)
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
            [userId]: userState
          }
        }
      }
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
          users: nextUsers
        }
      }
    });
  },
  updateVoiceUserState: ({ channelId, userId, newState }) => {
    const storeState = get();
    const channelState = storeState.voiceMap[channelId];
    const currentVoiceState = channelState?.users[userId];

    if (!channelState || !currentVoiceState) {
      return;
    }

    set({
      voiceMap: {
        ...storeState.voiceMap,
        [channelId]: {
          ...channelState,
          users: {
            ...channelState.users,
            [userId]: {
              ...currentVoiceState,
              ...newState
            }
          }
        }
      }
    });
  },
  updateOwnVoiceState: (newState) => {
    set({
      ownVoiceState: {
        ...get().ownVoiceState,
        ...newState
      }
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
          [streamId]: stream
        }
      }
    });
  },
  updateExternalStreamInChannel: ({ channelId, streamId, stream }) => {
    const storeState = get();
    const channelStreams = storeState.externalStreamsMap[channelId];

    if (!channelStreams || !channelStreams[streamId]) {
      return;
    }

    set({
      externalStreamsMap: {
        ...storeState.externalStreamsMap,
        [channelId]: {
          ...channelStreams,
          [streamId]: stream
        }
      }
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
        [channelId]: nextChannelStreams
      }
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
        [command.pluginId]: [...existingCommands, command]
      }
    });
  },
  removePluginCommand: ({ commandName }) => {
    const pluginCommands = get().pluginCommands;
    const nextPluginCommands = Object.fromEntries(
      Object.entries(pluginCommands).map(([pluginId, commands]) => [
        pluginId,
        commands.filter((command) => command.name !== commandName)
      ])
    );

    set({
      pluginCommands: nextPluginCommands
    });
  }
}));
