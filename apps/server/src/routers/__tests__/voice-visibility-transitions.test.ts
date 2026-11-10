import { afterEach, expect, test } from 'bun:test';
import { ChannelPermission, ServerEvents } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';
import { type Events, pubsub } from '../../utils/pubsub';

const subscriptions: { unsubscribe(): void }[] = [];
const state = { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false };
const observe = <T extends keyof Events>(topic: T) => {
	const events: Events[T][] = [];
	subscriptions.push(pubsub.subscribeFor(2, topic).subscribe({ next: (event) => events.push(event) }));
	return events;
};
const setup = async () => {
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	const { caller: owner } = await initTest(1);
	await initTest(2);
	await owner.channels.update({ channelId: 2, private: true });
	await owner.voice.join({ channelId: 2, state });
	const streamId = runtime.createExternalStream({
		title: 'Private title',
		key: 'private',
		pluginId: 'test',
		producers: {},
	});
	return { owner, streamId };
};
afterEach(async () => {
	for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
	const runtime = VoiceRuntime.findById(2);
	if (runtime) {
		for (const user of [...runtime.getState().users]) runtime.removeUser(user.userId);
		await runtime.destroy();
	}
});

for (const change of [
	'save',
	'update permissions',
	'delete permissions',
	'add role',
	'remove role',
	'delete role',
] as const) {
	test(`never-viewers receive no private membership or stream withdrawals on ${change}`, async () => {
		const { owner } = await setup();
		const roleId = await owner.roles.add();
		if (change === 'remove role' || change === 'delete role') await owner.users.addRole({ userId: 2, roleId });
		// Deny rows make user 2 affected without making them a viewer.
		if (change === 'update permissions' || change === 'delete permissions') {
			await owner.channels.updatePermissions({ channelId: 2, userId: 2, permissions: [] });
		}
		const leaves = observe(ServerEvents.USER_LEAVE_VOICE);
		const removes = observe(ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM);
		if (change === 'save') await owner.channels.update({ channelId: 2, name: 'renamed', private: true });
		if (change === 'update permissions')
			await owner.channels.updatePermissions({ channelId: 2, userId: 2, permissions: [] });
		if (change === 'delete permissions') await owner.channels.deletePermissions({ channelId: 2, userId: 2 });
		if (change === 'add role') await owner.users.addRole({ userId: 2, roleId });
		if (change === 'remove role') await owner.users.removeRole({ userId: 2, roleId });
		if (change === 'delete role') await owner.roles.delete({ roleId });
		expect([leaves, removes]).toEqual([[], []]);
	});
}
for (const loss of ['remove role', 'delete role', 'update permissions', 'delete permissions'] as const) {
	test(`access gain snapshots current members and ${loss} withdraws them`, async () => {
		const { owner, streamId } = await setup();
		const roleId = await owner.roles.add();
		await owner.channels.updatePermissions({ channelId: 2, roleId, permissions: [ChannelPermission.VIEW_CHANNEL] });
		const joins = observe(ServerEvents.USER_JOIN_VOICE);
		const adds = observe(ServerEvents.VOICE_ADD_EXTERNAL_STREAM);
		const leaves = observe(ServerEvents.USER_LEAVE_VOICE);
		const removes = observe(ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM);
		if (loss === 'remove role' || loss === 'delete role') await owner.users.addRole({ userId: 2, roleId });
		else
			await owner.channels.updatePermissions({
				channelId: 2,
				userId: 2,
				permissions: [ChannelPermission.VIEW_CHANNEL],
			});
		expect(joins).toEqual([{ channelId: 2, userId: 1, state, reconnecting: true }]);
		expect(adds).toEqual([expect.objectContaining({ channelId: 2, streamId })]);
		expect(leaves).toEqual([]);
		expect(removes).toEqual([]);
		if (loss === 'remove role') await owner.users.removeRole({ userId: 2, roleId });
		if (loss === 'delete role') await owner.roles.delete({ roleId });
		if (loss === 'update permissions')
			await owner.channels.updatePermissions({ channelId: 2, userId: 2, permissions: [] });
		if (loss === 'delete permissions') await owner.channels.deletePermissions({ channelId: 2, userId: 2 });
		expect(leaves).toEqual([{ channelId: 2, userId: 1, reconnecting: true }]);
		expect(removes).toEqual([{ channelId: 2, streamId }]);
	});
}
test('unchanged access does not replay members or streams on saves and unrelated role changes', async () => {
	const { owner } = await setup();
	await owner.channels.updatePermissions({ channelId: 2, userId: 2, permissions: [ChannelPermission.VIEW_CHANNEL] });
	const roleId = await owner.roles.add();
	const joins = observe(ServerEvents.USER_JOIN_VOICE);
	const adds = observe(ServerEvents.VOICE_ADD_EXTERNAL_STREAM);
	await owner.channels.update({ channelId: 2, private: true });
	await owner.users.addRole({ userId: 2, roleId });
	await owner.users.removeRole({ userId: 2, roleId });
	expect(joins).toEqual([]);
	expect(adds).toEqual([]);
});

test('role access loss still delivers the evicted member their own leave', async () => {
	const { owner } = await setup();
	const roleId = await owner.roles.add();
	await owner.channels.updatePermissions({
		channelId: 2,
		roleId,
		permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.JOIN],
	});
	await owner.users.addRole({ userId: 2, roleId });
	const { caller: member } = await initTest(2);
	await member.voice.join({ channelId: 2, state });
	const leaves = observe(ServerEvents.USER_LEAVE_VOICE);
	await owner.users.removeRole({ userId: 2, roleId });
	expect(leaves).toContainEqual(expect.objectContaining({ channelId: 2, userId: 2 }));
	expect(leaves).toContainEqual({ channelId: 2, userId: 1, reconnecting: true });
});
