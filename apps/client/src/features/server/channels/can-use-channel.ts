import { ChannelPermission, OWNER_ROLE_ID } from '@sharkord/shared';
import type { IServerState } from '../slice';
import { channelByIdSelector, channelPermissionsByIdSelector } from './selectors';

// Resolve the requested channel directly, including restore before UI publication.
export const canUseChannel = (
	state: IServerState,
	channelId: number | undefined,
	permission: ChannelPermission,
): boolean => {
	const ownUser = state.users.find((user) => user.id === state.ownUserId);
	if (ownUser?.roleIds.includes(OWNER_ROLE_ID)) return true;
	const channel = channelId === undefined ? undefined : channelByIdSelector(state, channelId);
	if (!channel?.private) return true;
	const permissions = channelPermissionsByIdSelector(state, channel.id).permissions ?? {};
	return permissions[ChannelPermission.VIEW_CHANNEL] !== false && permissions[permission] === true;
};
