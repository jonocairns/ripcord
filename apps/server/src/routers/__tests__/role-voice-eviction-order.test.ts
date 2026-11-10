import { afterEach, expect, test } from 'bun:test';
import { ChannelPermission, ServerEvents } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

const state = { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false };

afterEach(async () => {
	const runtime = VoiceRuntime.findById(2);
	if (runtime) await runtime.destroy();
});

const recordEvents = () => {
	const events: ServerEvents[] = [];
	const subscriptions = [
		ServerEvents.ROLE_UPDATE,
		ServerEvents.USER_UPDATE,
		ServerEvents.CHANNEL_PERMISSIONS_UPDATE,
		ServerEvents.CHANNEL_DELETE,
		ServerEvents.USER_LEAVE_VOICE,
	].map((event) =>
		(event === ServerEvents.ROLE_UPDATE || event === ServerEvents.USER_UPDATE
			? pubsub.subscribe(event)
			: pubsub.subscribeFor(2, event)
		).subscribe({ next: () => events.push(event) }),
	);
	return { events, stop: () => subscriptions.forEach((subscription) => subscription.unsubscribe()) };
};

test('role updates reach the affected member before voice eviction', async () => {
	// update-role has no visibility step by design: channel visibility depends only on
	// channel grants and the owner role, not on global role permissions.
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	const { caller: owner } = await initTest(1);
	const { caller: member } = await initTest(2);
	await member.voice.join({ channelId: 2, state });
	const recorder = recordEvents();
	try {
		await owner.roles.update({ roleId: 2, name: 'Member', color: '#ffffff', permissions: [] });
		expect(recorder.events).toEqual([ServerEvents.ROLE_UPDATE, ServerEvents.USER_LEAVE_VOICE]);
		expect(runtime.getUser(2)).toBeUndefined();
	} finally {
		recorder.stop();
	}
});

test('role removal publishes user and permissions, then visibility, then voice eviction', async () => {
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	const { caller: owner } = await initTest(1);
	await owner.channels.update({ channelId: 2, private: true });
	const roleId = await owner.roles.add();
	await owner.channels.updatePermissions({
		channelId: 2,
		roleId,
		permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.JOIN],
	});
	await owner.users.addRole({ userId: 2, roleId });
	const { caller: member } = await initTest(2);
	await member.voice.join({ channelId: 2, state });
	const recorder = recordEvents();
	try {
		await owner.users.removeRole({ userId: 2, roleId });
		// The affected user receives the visibility withdrawal before eviction,
		// with both user and permission updates preceding either event.
		expect(recorder.events.slice(0, 2).sort()).toEqual(
			[ServerEvents.USER_UPDATE, ServerEvents.CHANNEL_PERMISSIONS_UPDATE].sort(),
		);
		expect(recorder.events.slice(2)).toEqual([ServerEvents.CHANNEL_DELETE, ServerEvents.USER_LEAVE_VOICE]);
		expect(runtime.getUser(2)).toBeUndefined();
	} finally {
		recorder.stop();
	}
});
