import { expect, it } from 'bun:test';
import { ChannelPermission, ChannelType, type TPublicChannel } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { canUseChannel } from '../can-use-channel';

it('checks SPEAK on the requested restore channel before UI channel publication', () => {
	const channel: TPublicChannel = {
		id: 9,
		name: 'listen only',
		topic: null,
		type: ChannelType.VOICE,
		private: true,
		position: 0,
		categoryId: 1,
		createdAt: 0,
		fileAccessTokenUpdatedAt: 0,
		updatedAt: null,
		voiceBitrate: 96000,
		voiceDtx: false,
	};
	const state = {
		...useServerStore.getState(),
		currentVoiceChannelId: undefined,
		users: [],
		channels: [channel],
		channelPermissions: {
			9: {
				channelId: 9,
				permissions: {
					VIEW_CHANNEL: true,
					JOIN: true,
					SPEAK: false,
					SEND_MESSAGES: false,
					SHARE_SCREEN: false,
					WEBCAM: false,
				},
			},
		},
	};
	expect(canUseChannel(state, 9, ChannelPermission.SPEAK)).toBe(false);
	expect(canUseChannel(state, 9, ChannelPermission.JOIN)).toBe(true);
	state.channelPermissions[9].permissions.SPEAK = true;
	expect(canUseChannel(state, 9, ChannelPermission.SPEAK)).toBe(true);
	state.channelPermissions[9].permissions.VIEW_CHANNEL = false;
	expect(canUseChannel(state, 9, ChannelPermission.SPEAK)).toBe(false);
});
