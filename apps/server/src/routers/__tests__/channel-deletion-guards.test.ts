import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, Permission, ServerEvents } from '@sharkord/shared';
import { eq, sql } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { categories, channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

const initModerator = async (permissions: Permission[]) => {
	const { caller: ownerCaller, initialData } = await initTest(1);
	const memberRole = initialData.roles.find((role) => role.isDefault);
	if (!memberRole) throw new Error('Default role not found');
	await ownerCaller.roles.update({
		roleId: memberRole.id,
		name: memberRole.name,
		color: memberRole.color,
		permissions: [...memberRole.permissions, ...permissions],
	});
	const { caller: moderatorCaller } = await initTest(2);
	return { ownerCaller, moderatorCaller };
};
const getChannel = (id: number) => tdb.select().from(channels).where(eq(channels.id, id)).get();
const getCategory = (id: number) => tdb.select().from(categories).where(eq(categories.id, id)).get();

describe('channel deletion and token guards', () => {
	for (const operation of ['delete', 'rotateFileAccessToken'] as const) {
		test(`a moderator cannot ${operation} an inaccessible private channel`, async () => {
			const { ownerCaller, moderatorCaller } = await initModerator([Permission.MANAGE_CHANNELS]);
			await ownerCaller.channels.update({ channelId: 1, private: true });
			const original = await getChannel(1);
			await expect(moderatorCaller.channels[operation]({ channelId: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
			expect(await getChannel(1)).toEqual(original);
		});
	}
	for (const actor of ['public moderator', 'owner', 'permitted moderator'] as const) {
		test(`${actor} can rotate tokens and delete the channel`, async () => {
			const { ownerCaller, moderatorCaller } = await initModerator([Permission.MANAGE_CHANNELS]);
			if (actor !== 'public moderator') await ownerCaller.channels.update({ channelId: 1, private: true });
			if (actor === 'permitted moderator')
				await ownerCaller.channels.updatePermissions({
					channelId: 1,
					userId: 2,
					permissions: [ChannelPermission.VIEW_CHANNEL],
				});
			const caller = actor === 'owner' ? ownerCaller : moderatorCaller;
			const original = await getChannel(1);
			await caller.channels.rotateFileAccessToken({ channelId: 1 });
			expect((await getChannel(1))?.fileAccessToken).not.toBe(original?.fileAccessToken);
			await caller.channels.delete({ channelId: 1 });
			expect(await getChannel(1)).toBeUndefined();
		});
	}
	test('missing channels return NOT_FOUND', async () => {
		const { caller } = await initTest();
		await expect(caller.channels.delete({ channelId: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(caller.channels.rotateFileAccessToken({ channelId: 999 })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});
});

describe('category deletion guards and cleanup', () => {
	test('MANAGE_CATEGORIES alone can delete an empty category', async () => {
		const { ownerCaller, moderatorCaller } = await initModerator([Permission.MANAGE_CATEGORIES]);
		const categoryId = await ownerCaller.categories.add({ name: 'Empty' });
		await moderatorCaller.categories.delete({ categoryId });
		expect(await getCategory(categoryId)).toBeUndefined();
	});
	test('MANAGE_CATEGORIES alone cannot delete a category containing channels', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_CATEGORIES]);
		await expect(moderatorCaller.categories.delete({ categoryId: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(await getCategory(1)).toBeDefined();
		expect(await getChannel(1)).toBeDefined();
	});
	test('both management permissions still require access to every private channel', async () => {
		const { ownerCaller, moderatorCaller } = await initModerator([
			Permission.MANAGE_CATEGORIES,
			Permission.MANAGE_CHANNELS,
		]);
		await ownerCaller.channels.update({ channelId: 1, private: true });
		await expect(moderatorCaller.categories.delete({ categoryId: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(await getCategory(1)).toBeDefined();
		expect(await getChannel(1)).toBeDefined();
		await ownerCaller.channels.updatePermissions({
			channelId: 1,
			userId: 2,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});
		await moderatorCaller.categories.delete({ categoryId: 1 });
		expect(await getCategory(1)).toBeUndefined();
		expect(await getChannel(1)).toBeUndefined();
	});
	test('owner deletion removes channels and runtime, publishing channel deletes before category delete', async () => {
		const { caller } = await initTest();
		const voiceChannelId = await caller.channels.add({
			name: 'Category voice',
			type: ChannelType.VOICE,
			categoryId: 1,
		});
		const runtime = new VoiceRuntime(voiceChannelId);
		await runtime.init();
		const events: string[] = [];
		const channelSub = pubsub
			.subscribeFor(2, ServerEvents.CHANNEL_DELETE)
			.subscribe({ next: (id) => events.push(`channel:${id}`) });
		const categorySub = pubsub
			.subscribe(ServerEvents.CATEGORY_DELETE)
			.subscribe({ next: (id) => events.push(`category:${id}`) });
		try {
			await caller.categories.delete({ categoryId: 1 });
			expect(await getChannel(1)).toBeUndefined();
			expect(await getChannel(voiceChannelId)).toBeUndefined();
			expect(await getCategory(1)).toBeUndefined();
			expect(VoiceRuntime.findById(voiceChannelId)).toBeUndefined();
			expect(events.slice(0, -1).sort()).toEqual(['channel:1', `channel:${voiceChannelId}`].sort());
			expect(events.at(-1)).toBe('category:1');
		} finally {
			channelSub.unsubscribe();
			categorySub.unsubscribe();
			await runtime.destroy();
		}
	});
	test('a category delete failure rolls back channel deletion', async () => {
		const { caller } = await initTest();
		tdb.run(
			sql.raw(
				"CREATE TRIGGER fail_category_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'forced'); END;",
			),
		);
		await expect(caller.categories.delete({ categoryId: 1 })).rejects.toThrow('forced');
		expect(await getChannel(1)).toBeDefined();
		expect(await getCategory(1)).toBeDefined();
	});
});
