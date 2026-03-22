import {
	ChannelPermission,
	UserStatus,
	type TChannelPermissionsMap,
	type TJoinedPublicUser,
	type TServerInfo,
} from '@sharkord/shared';
import type { TInitialServerData } from './server-store';

const createUser = (overrides: Partial<TJoinedPublicUser> = {}): TJoinedPublicUser => ({
	id: 1,
	name: 'Test User',
	bannerColor: '#123456',
	bio: 'Fixture user',
	avatar: null,
	avatarId: null,
	banner: null,
	bannerId: null,
	banned: false,
	createdAt: 1,
	roleIds: [],
	status: UserStatus.ONLINE,
	...overrides,
});

const createServerInfo = (overrides: Partial<TServerInfo> = {}): TServerInfo => ({
	serverId: 'server-1',
	name: 'Sharkord Test',
	description: 'Fixture server',
	allowNewUsers: true,
	logo: null,
	version: '1.0.0',
	...overrides,
});

const createChannelPermissions = (overrides: Partial<TChannelPermissionsMap> = {}): TChannelPermissionsMap => ({
	[ChannelPermission.VIEW_CHANNEL]: true,
	[ChannelPermission.SEND_MESSAGES]: true,
	[ChannelPermission.JOIN]: true,
	[ChannelPermission.SPEAK]: true,
	[ChannelPermission.SHARE_SCREEN]: true,
	[ChannelPermission.WEBCAM]: true,
	...overrides,
});

const createInitialServerData = (overrides: Partial<TInitialServerData> = {}): TInitialServerData => ({
	serverId: 'server-1',
	categories: [],
	channels: [],
	users: [createUser()],
	ownUserId: 1,
	mustChangePassword: false,
	roles: [],
	emojis: [],
	publicSettings: undefined,
	voiceMap: {},
	externalStreamsMap: {},
	channelPermissions: {},
	readStates: {},
	...overrides,
});

export { createChannelPermissions, createInitialServerData, createServerInfo, createUser };
