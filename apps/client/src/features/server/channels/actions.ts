import type { TChannel, TChannelUserPermissionsMap } from '@sharkord/shared';
import { useServerStore } from '../slice';
import { channelByIdSelector, channelReadStateByIdSelector, selectedChannelIdSelector } from './selectors';

export const setChannels = (channels: TChannel[]) => {
	useServerStore.getState().setChannels(channels);
};

export const setSelectedChannelId = (channelId: number | undefined) => {
	useServerStore.getState().setSelectedChannelId(channelId);
};

export const setCurrentVoiceChannelId = (channelId: number | undefined) =>
	useServerStore.getState().setCurrentVoiceChannelId(channelId);

export const addChannel = (channel: TChannel) => {
	useServerStore.getState().addChannel(channel);
};

export const updateChannel = (channelId: number, channel: Partial<TChannel>) => {
	useServerStore.getState().updateChannel({ channelId, channel });
};

export const removeChannel = (channelId: number) => {
	useServerStore.getState().removeChannel({ channelId });
};

export const setChannelPermissions = (permissions: TChannelUserPermissionsMap) => {
	useServerStore.getState().setChannelPermissions(permissions);

	const state = useServerStore.getState();
	const selectedChannel = selectedChannelIdSelector(state);

	if (!selectedChannel) return;

	const channel = channelByIdSelector(state, selectedChannel || -1);

	if (!channel?.private) return;

	// user is in a channel that is private, so we need to check if their permissions changed
	const canViewChannel = permissions[selectedChannel]?.permissions.VIEW_CHANNEL === true;

	if (!canViewChannel) {
		// user lost VIEW_CHANNEL permission, deselect the channel
		setSelectedChannelId(undefined);
	}
};

export const setChannelReadState = (
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

	let actualCount = nextCount;

	// if the channel is currently selected, set the read count to 0
	if (selectedChannel === channelId) {
		actualCount = 0;

		// we also need to notify the server that the channel has been read
		// otherwise the count will be wrong when the user joins the server again
		// we can't do it here to avoid infinite loops
	}

	useServerStore.getState().setChannelReadState({
		channelId,
		count: actualCount,
	});
};
