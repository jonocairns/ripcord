import { describe, expect, test } from 'bun:test';
import { ChannelType, Permission, ServerEvents, type TJoinedRole, type TTempFile } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { initTest, login, uploadFile } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { channels, messageFiles } from '../../db/schema';
import { verifyFileToken } from '../../helpers/files-crypto';
import { pubsub } from '../../utils/pubsub';

type TCaller = Awaited<ReturnType<typeof initTest>>['caller'];

const OWNER_ID = 1;
const MEMBER_ID = 2;

const getChannelFileAccessToken = async (channelId: number) => {
	const channel = await tdb.select().from(channels).where(eq(channels.id, channelId)).get();

	if (!channel) throw new Error(`Channel ${channelId} not found`);

	return channel.fileAccessToken;
};

const getOwnerUploadToken = async () => {
	const response = await login('testowner', 'password123');
	const { token } = (await response.json()) as { token: string };

	return token;
};

// Sends a message with one attached file and returns the stored file ID.
const sendFile = async (caller: TCaller, uploadToken: string, channelId: number, name: string) => {
	const response = await uploadFile(new File([`content of ${name}`], name, { type: 'text/plain' }), uploadToken);
	const tempFile = (await response.json()) as TTempFile;
	const messageId = await caller.messages.send({ channelId, content: name, files: [tempFile.id] });
	const messageFile = await tdb.select().from(messageFiles).where(eq(messageFiles.messageId, messageId)).get();

	if (!messageFile) throw new Error(`No file stored for message ${messageId}`);

	return messageFile.fileId;
};

const addTextChannel = async (caller: TCaller, name: string, isPrivate: boolean) => {
	const channelId = await caller.channels.add({ type: ChannelType.TEXT, name, categoryId: 1 });

	if (isPrivate) {
		await caller.channels.update({ channelId, private: true });
	}

	return channelId;
};

describe('files.getAccessTokens', () => {
	test('signs files attached to messages in a private channel', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const channelId = await addTextChannel(caller, 'private-files', true);
		const firstFileId = await sendFile(caller, uploadToken, channelId, 'first.txt');
		const secondFileId = await sendFile(caller, uploadToken, channelId, 'second.txt');

		const tokens = await caller.files.getAccessTokens({ channelId, fileIds: [firstFileId, secondFileId] });
		const channelToken = await getChannelFileAccessToken(channelId);

		expect(tokens.map(({ fileId }) => fileId).sort()).toEqual([firstFileId, secondFileId].sort());

		for (const { fileId, accessToken } of tokens) {
			expect(verifyFileToken(fileId, channelToken, accessToken)).toBe(true);
		}
	});

	test('returns tokens for the rotated channel token', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const channelId = await addTextChannel(caller, 'rotated-files', true);
		const fileId = await sendFile(caller, uploadToken, channelId, 'rotated.txt');
		const [before] = await caller.files.getAccessTokens({ channelId, fileIds: [fileId] });

		await caller.channels.rotateFileAccessToken({ channelId });

		const [after] = await caller.files.getAccessTokens({ channelId, fileIds: [fileId] });
		const channelToken = await getChannelFileAccessToken(channelId);

		expect(after?.accessToken).not.toBe(before?.accessToken);
		expect(verifyFileToken(fileId, channelToken, after?.accessToken ?? '')).toBe(true);
	});

	test('leaves out files from other channels and unknown IDs', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const channelId = await addTextChannel(caller, 'private-a', true);
		const otherPrivateChannelId = await addTextChannel(caller, 'private-b', true);
		const ownFileId = await sendFile(caller, uploadToken, channelId, 'own.txt');
		const otherPrivateFileId = await sendFile(caller, uploadToken, otherPrivateChannelId, 'other-private.txt');
		const publicFileId = await sendFile(caller, uploadToken, 1, 'public.txt');

		const tokens = await caller.files.getAccessTokens({
			channelId,
			fileIds: [ownFileId, otherPrivateFileId, publicFileId, 99_999],
		});

		expect(tokens.map(({ fileId }) => fileId)).toEqual([ownFileId]);
	});

	test('returns nothing for a public channel', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const fileId = await sendFile(caller, uploadToken, 1, 'public.txt');

		expect(await caller.files.getAccessTokens({ channelId: 1, fileIds: [fileId] })).toEqual([]);
	});

	test('refuses a caller without VIEW_CHANNEL on the channel', async () => {
		const { caller: ownerCaller } = await initTest(OWNER_ID);
		const { caller: memberCaller } = await initTest(MEMBER_ID);
		const uploadToken = await getOwnerUploadToken();
		const channelId = await addTextChannel(ownerCaller, 'staff', true);
		const fileId = await sendFile(ownerCaller, uploadToken, channelId, 'staff.txt');

		await expect(memberCaller.files.getAccessTokens({ channelId, fileIds: [fileId] })).rejects.toThrow(
			'Insufficient channel permissions',
		);
	});

	test('refuses a channel that does not exist', async () => {
		const { caller } = await initTest(OWNER_ID);

		await expect(caller.files.getAccessTokens({ channelId: 999, fileIds: [1] })).rejects.toThrow(
			'Insufficient channel permissions',
		);
	});

	test('refuses more than 100 file IDs', async () => {
		const { caller } = await initTest(OWNER_ID);
		const channelId = await addTextChannel(caller, 'many-files', true);
		const fileIds = Array.from({ length: 101 }, (_, index) => index + 1);

		await expect(caller.files.getAccessTokens({ channelId, fileIds })).rejects.toThrow();
		expect(await caller.files.getAccessTokens({ channelId, fileIds: fileIds.slice(0, 100) })).toEqual([]);
	});
});

describe('users.getInfo files', () => {
	const grantMemberManageUsers = async (ownerCaller: TCaller, roles: TJoinedRole[]) => {
		const memberRole = roles.find((role) => role.isDefault);

		if (!memberRole) throw new Error('Default role not found');

		await ownerCaller.roles.update({
			roleId: memberRole.id,
			name: memberRole.name,
			color: memberRole.color,
			permissions: [...memberRole.permissions, Permission.MANAGE_USERS],
		});
	};

	test('leaves out private channel files the caller cannot view', async () => {
		const { caller: ownerCaller, initialData } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const privateChannelId = await addTextChannel(ownerCaller, 'secret', true);
		const privateFileId = await sendFile(ownerCaller, uploadToken, privateChannelId, 'secret-plans.txt');
		const publicFileId = await sendFile(ownerCaller, uploadToken, 1, 'public-notes.txt');

		await grantMemberManageUsers(ownerCaller, initialData.roles);

		const { caller: moderatorCaller } = await initTest(MEMBER_ID);
		const { files } = await moderatorCaller.users.getInfo({ userId: OWNER_ID });

		expect(files.map((file) => file.id)).toEqual([publicFileId]);
		expect(files[0]?._accessToken).toBeUndefined();
		expect(files.some((file) => file.id === privateFileId)).toBe(false);
	});

	test('signs private channel files the caller can view', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const privateChannelId = await addTextChannel(caller, 'secret', true);
		const privateFileId = await sendFile(caller, uploadToken, privateChannelId, 'secret-plans.txt');
		const publicFileId = await sendFile(caller, uploadToken, 1, 'public-notes.txt');

		const { files } = await caller.users.getInfo({ userId: OWNER_ID });
		const privateFile = files.find((file) => file.id === privateFileId);
		const publicFile = files.find((file) => file.id === publicFileId);
		const channelToken = await getChannelFileAccessToken(privateChannelId);

		expect(verifyFileToken(privateFileId, channelToken, privateFile?._accessToken ?? '')).toBe(true);
		expect(publicFile).toBeDefined();
		expect(publicFile?._accessToken).toBeUndefined();
	});
});

// Records CHANNEL_FILE_ACCESS_CHANGED events delivered to each user.
const recordFileAccessEvents = (userIds: number[]) => {
	const received: Record<number, number[]> = {};
	const subscriptions = userIds.map((userId) => {
		received[userId] = [];

		return pubsub.subscribeFor(userId, ServerEvents.CHANNEL_FILE_ACCESS_CHANGED).subscribe({
			next: ({ channelId }) => received[userId]?.push(channelId),
		});
	});

	return {
		received,
		clear: () => {
			for (const userId of userIds) received[userId] = [];
		},
		stop: () => {
			for (const subscription of subscriptions) subscription.unsubscribe();
		},
	};
};

describe('CHANNEL_FILE_ACCESS_CHANGED', () => {
	test('rotating a private channel token reaches only users with VIEW_CHANNEL', async () => {
		const { caller } = await initTest(OWNER_ID);
		const channelId = await addTextChannel(caller, 'staff', true);
		const events = recordFileAccessEvents([OWNER_ID, MEMBER_ID]);

		try {
			await caller.channels.rotateFileAccessToken({ channelId });

			expect(events.received).toEqual({ [OWNER_ID]: [channelId], [MEMBER_ID]: [] });
		} finally {
			events.stop();
		}
	});

	test('rotating a public channel token reaches every viewer', async () => {
		const { caller } = await initTest(OWNER_ID);
		const events = recordFileAccessEvents([OWNER_ID, MEMBER_ID]);

		try {
			await caller.channels.rotateFileAccessToken({ channelId: 1 });

			expect(events.received).toEqual({ [OWNER_ID]: [1], [MEMBER_ID]: [1] });
		} finally {
			events.stop();
		}
	});

	test('turning a channel private or public publishes to its viewers', async () => {
		const { caller } = await initTest(OWNER_ID);
		const channelId = await addTextChannel(caller, 'toggled', false);
		const events = recordFileAccessEvents([OWNER_ID, MEMBER_ID]);

		try {
			await caller.channels.update({ channelId, private: true });

			// The member lost access, so only the owner refreshes.
			expect(events.received).toEqual({ [OWNER_ID]: [channelId], [MEMBER_ID]: [] });

			events.clear();
			await caller.channels.update({ channelId, private: false });

			expect(events.received).toEqual({ [OWNER_ID]: [channelId], [MEMBER_ID]: [channelId] });
		} finally {
			events.stop();
		}
	});

	test('an update that leaves private alone publishes nothing', async () => {
		const { caller } = await initTest(OWNER_ID);
		const channelId = await addTextChannel(caller, 'unchanged', true);
		const events = recordFileAccessEvents([OWNER_ID, MEMBER_ID]);

		try {
			await caller.channels.update({ channelId, topic: 'new topic' });
			await caller.channels.update({ channelId, private: true });

			expect(events.received).toEqual({ [OWNER_ID]: [], [MEMBER_ID]: [] });
		} finally {
			events.stop();
		}
	});
});
