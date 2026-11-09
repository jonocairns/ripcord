import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { channels, files, messageFiles, messages } from '../../db/schema';

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
	const privateChannelId = await ownerCaller.channels.add({ type: ChannelType.TEXT, name: 'secret', categoryId: 1 });
	await ownerCaller.channels.update({ channelId: privateChannelId, private: true });

	return { ownerCaller, moderatorCaller, privateChannelId };
};

const addAttachment = async (channelId: number) => {
	const message = await tdb
		.insert(messages)
		.values({ channelId, userId: 1, content: 'attachment', createdAt: 1 })
		.returning()
		.get();
	const file = await tdb
		.insert(files)
		.values({
			name: `attachment-${channelId}.txt`,
			originalName: 'attachment.txt',
			md5: 'test',
			userId: 1,
			size: 10,
			mimeType: 'text/plain',
			extension: '.txt',
			createdAt: 1,
		})
		.returning()
		.get();
	await tdb.insert(messageFiles).values({ messageId: message.id, fileId: file.id, createdAt: 1 });
	return { message, file };
};

describe('private channel guards', () => {
	test('MANAGE_CHANNELS alone cannot read or change any field of a private channel', async () => {
		const { moderatorCaller, privateChannelId } = await initModerator([Permission.MANAGE_CHANNELS]);

		for (const update of [{ name: 'renamed' }, { topic: 'hidden' }, { private: false }]) {
			await expect(moderatorCaller.channels.update({ channelId: privateChannelId, ...update })).rejects.toMatchObject({
				code: 'FORBIDDEN',
			});
		}
		await expect(moderatorCaller.channels.get({ channelId: privateChannelId })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		});

		const channel = await tdb.select().from(channels).where(eq(channels.id, privateChannelId)).get();
		expect(channel?.private).toBe(true);
		expect(channel?.name).toBe('secret');
		expect(channel?.topic).toBeNull();
	});

	test('MANAGE_CHANNELS can rename and read a public channel with the shipped client payload', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_CHANNELS]);
		await moderatorCaller.channels.update({ channelId: 1, name: 'renamed', private: false });
		expect(await moderatorCaller.channels.get({ channelId: 1 })).toMatchObject({ name: 'renamed', private: false });
	});

	test('owners can read and update private channels', async () => {
		const { ownerCaller, privateChannelId } = await initModerator([]);
		await ownerCaller.channels.update({ channelId: privateChannelId, name: 'owner-edit' });
		expect(await ownerCaller.channels.get({ channelId: privateChannelId })).toMatchObject({
			name: 'owner-edit',
			private: true,
		});
	});

	test('moderators granted VIEW_CHANNEL can read and update private channels', async () => {
		const { ownerCaller, moderatorCaller, privateChannelId } = await initModerator([Permission.MANAGE_CHANNELS]);
		await ownerCaller.channels.updatePermissions({
			channelId: privateChannelId,
			userId: 2,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});
		await moderatorCaller.channels.update({ channelId: privateChannelId, name: 'allowed-edit' });
		expect(await moderatorCaller.channels.get({ channelId: privateChannelId })).toMatchObject({
			name: 'allowed-edit',
			private: true,
		});
		await moderatorCaller.channels.update({ channelId: privateChannelId, private: false });
		expect(await moderatorCaller.channels.get({ channelId: privateChannelId })).toMatchObject({ private: false });
	});

	test('missing channels return NOT_FOUND on get and update', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_CHANNELS]);
		await expect(moderatorCaller.channels.get({ channelId: 999 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await expect(moderatorCaller.channels.update({ channelId: 999, name: 'missing' })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});

	test('MANAGE_MESSAGES cannot delete hidden attachments but can delete public attachments', async () => {
		const { moderatorCaller, privateChannelId } = await initModerator([Permission.MANAGE_MESSAGES]);
		const hidden = await addAttachment(privateChannelId);
		const visible = await addAttachment(1);

		await expect(moderatorCaller.files.delete({ fileId: hidden.file.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(await tdb.select().from(files).where(eq(files.id, hidden.file.id)).get()).toBeDefined();
		expect(await tdb.select().from(messageFiles).where(eq(messageFiles.fileId, hidden.file.id)).get()).toBeDefined();

		await moderatorCaller.files.delete({ fileId: visible.file.id });
		expect(await tdb.select().from(files).where(eq(files.id, visible.file.id)).get()).toBeUndefined();
	});
});
