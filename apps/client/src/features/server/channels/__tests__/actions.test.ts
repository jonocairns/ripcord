import { beforeEach, describe, expect, test } from 'bun:test';
import { ChannelType, type TPublicChannel } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { removeChannel, setChannelPermissions } from '../actions';

const channel: TPublicChannel = {
	id: 1,
	name: 'general',
	topic: null,
	type: ChannelType.TEXT,
	private: false,
	position: 0,
	categoryId: 1,
	createdAt: 0,
	fileAccessTokenUpdatedAt: 0,
	updatedAt: null,
	voiceBitrate: 96000,
	voiceDtx: false,
};

describe('channel access transitions', () => {
	beforeEach(() => useServerStore.getState().resetState());

	test('withdrawing a selected public channel clears selection and text fallback', () => {
		useServerStore.setState({ channels: [channel], selectedChannelId: 1, lastTextChannelId: 1 });
		removeChannel(1);
		expect(useServerStore.getState().selectedChannelId).toBeUndefined();
		expect(useServerStore.getState().lastTextChannelId).toBeUndefined();
		expect(useServerStore.getState().channels).toEqual([]);
	});

	test('withdrawing an unrelated channel preserves selection', () => {
		useServerStore.setState({ channels: [channel], selectedChannelId: 2, lastTextChannelId: 2 });
		removeChannel(1);
		expect(useServerStore.getState().selectedChannelId).toBe(2);
		expect(useServerStore.getState().lastTextChannelId).toBe(2);
	});

	test('effective owner permissions retain a selected private channel', () => {
		useServerStore.setState({ channels: [{ ...channel, private: true }], selectedChannelId: 1 });
		setChannelPermissions({
			1: {
				channelId: 1,
				permissions: {
					VIEW_CHANNEL: true,
					SEND_MESSAGES: true,
					JOIN: true,
					SPEAK: true,
					SHARE_SCREEN: true,
					WEBCAM: true,
				},
			},
		});
		expect(useServerStore.getState().selectedChannelId).toBe(1);
	});
});
