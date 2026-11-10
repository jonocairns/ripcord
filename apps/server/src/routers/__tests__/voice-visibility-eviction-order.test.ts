import { afterEach, expect, test } from 'bun:test';
import { ChannelPermission, ServerEvents } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { userRoles, users } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

const state = { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false };
afterEach(async () => {
	const runtime = VoiceRuntime.findById(2);
	if (runtime) {
		for (const user of [...runtime.getState().users]) runtime.removeUser(user.userId);
		await runtime.destroy();
	}
});

test('a watcher losing access together with an evicted member is told the member left', async () => {
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	const { caller: owner } = await initTest(1);
	const [u3] = await tdb
		.insert(users)
		.values({ name: 'Three', identity: 'three', password: 'x', createdAt: Date.now() })
		.returning();
	await tdb
		.insert(userRoles)
		.values({ userId: u3!.id, roleId: 2, createdAt: Date.now() })
		.catch(() => {});
	await owner.channels.update({ channelId: 2, private: true });
	const roleId = await owner.roles.add();
	await owner.channels.updatePermissions({
		channelId: 2,
		roleId,
		permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.JOIN],
	});
	await owner.users.addRole({ userId: 2, roleId });
	await owner.users.addRole({ userId: u3!.id, roleId });
	await owner.voice.join({ channelId: 2, state });
	const { caller: member } = await initTest(2);
	await member.voice.join({ channelId: 2, state });
	const leaves: unknown[] = [];
	const sub = pubsub.subscribeFor(u3!.id, ServerEvents.USER_LEAVE_VOICE).subscribe({ next: (e) => leaves.push(e) });
	await owner.channels.deletePermissions({ channelId: 2, roleId });
	sub.unsubscribe();
	expect(leaves).toContainEqual(expect.objectContaining({ channelId: 2, userId: 2 }));
});
