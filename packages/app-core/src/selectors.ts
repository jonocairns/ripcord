import { OWNER_ROLE_ID } from '@sharkord/shared';
import { currentVoiceChannelIdSelector } from './channels-selectors';
import { typingMapSelector } from './messages-selectors';
import { rolesSelector } from './roles-selectors';
import type { IServerState } from './server-store';
import type { TVoiceUser } from './types';
import { ownUserIdSelector, ownUserSelector, userByIdSelector, usersSelector } from './users-selectors';
import { voiceChannelStateSelector } from './voice-selectors';

export const connectedSelector = (state: IServerState) => state.connected;

export const disconnectInfoSelector = (state: IServerState) => state.disconnectInfo;

export const connectingSelector = (state: IServerState) => state.connecting;

export const mustChangePasswordSelector = (state: IServerState) => state.mustChangePassword;

export const serverNameSelector = (state: IServerState) => state.publicSettings?.name;

export const serverIdSelector = (state: IServerState) => state.publicSettings?.serverId;

export const publicServerSettingsSelector = (state: IServerState) => state.publicSettings;

export const pluginsEnabledSelector = (state: IServerState) => !!state.publicSettings?.enablePlugins;

export const infoSelector = (state: IServerState) => state.info;

export const ownUserRolesSelector = (state: IServerState) => {
	const ownUser = ownUserSelector(state);
	const roles = rolesSelector(state);

	if (!ownUser?.roleIds) {
		return [];
	}

	return roles.filter((role) => ownUser.roleIds.includes(role.id));
};

export const isOwnUserOwnerSelector = (state: IServerState) =>
	ownUserRolesSelector(state).some((role) => role.id === OWNER_ROLE_ID);

export const userRolesSelector = (state: IServerState, userId: number) => {
	const roles = rolesSelector(state);
	const user = userByIdSelector(state, userId);

	if (!user?.roleIds) {
		return [];
	}

	return roles.filter((role) => user.roleIds.includes(role.id));
};

export const userRolesIdsSelector = (state: IServerState, userId: number) =>
	userByIdSelector(state, userId)?.roleIds || [];

export const typingUsersByChannelIdSelector = (state: IServerState, channelId: number) => {
	const typingMap = typingMapSelector(state);
	const ownUserId = ownUserIdSelector(state);
	const users = usersSelector(state);
	const userIds = typingMap[channelId] || [];

	return userIds
		.filter((id) => id !== ownUserId)
		.map((id) => users.find((user) => user.id === id))
		.filter((user): user is NonNullable<typeof user> => !!user);
};

export const voiceUsersByChannelIdSelector = (state: IServerState, channelId: number) => {
	const users = usersSelector(state);
	const voiceState = voiceChannelStateSelector(state, channelId);
	const voiceUsers: TVoiceUser[] = [];

	if (!voiceState) {
		return voiceUsers;
	}

	Object.entries(voiceState.users).forEach(([userIdStr, userState]) => {
		const userId = Number(userIdStr);
		const user = users.find((entry) => entry.id === userId);

		if (user) {
			voiceUsers.push({
				...user,
				state: userState,
			});
		}
	});

	return voiceUsers;
};

export const ownVoiceUserSelector = (state: IServerState) => {
	const ownUserId = ownUserIdSelector(state);
	const channelId = currentVoiceChannelIdSelector(state);

	if (channelId === undefined) {
		return undefined;
	}

	return voiceUsersByChannelIdSelector(state, channelId).find((voiceUser) => voiceUser.id === ownUserId);
};
