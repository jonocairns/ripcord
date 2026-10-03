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

const uploadAvatar = async (caller: TCaller, uploadToken: string) => {
	const response = await uploadFile(new File(['avatar'], 'avatar.png', { type: 'image/png' }), uploadToken);
	const tempFile = (await response.json()) as TTempFile;

	await caller.users.changeAvatar({ fileId: tempFile.id });

	const { user } = await caller.users.getInfo({ userId: OWNER_ID });

	if (!user.avatarId) throw new Error('Avatar not stored');

	return user.avatarId;
};

describe('files.refreshAccessTokens', () => {
	test('signs attachments across public and private channels the caller can view', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const privateChannelId = await addTextChannel(caller, 'private-files', true);
		const privateFileId = await sendFile(caller, uploadToken, privateChannelId, 'private.txt');
		const publicFileId = await sendFile(caller, uploadToken, 1, 'public.txt');

		const tokens = await caller.files.refreshAccessTokens({ fileIds: [privateFileId, publicFileId] });
		const tokenByFileId = new Map(tokens.map(({ fileId, accessToken }) => [fileId, accessToken]));

		expect([...tokenByFileId.keys()].sort()).toEqual([privateFileId, publicFileId].sort());
		expect(
			verifyFileToken(
				privateFileId,
				await getChannelFileAccessToken(privateChannelId),
				tokenByFileId.get(privateFileId) ?? '',
			),
		).toBe(true);
		expect(
			verifyFileToken(publicFileId, await getChannelFileAccessToken(1), tokenByFileId.get(publicFileId) ?? ''),
		).toBe(true);
	});

	test('returns tokens for the rotated channel token', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const channelId = await addTextChannel(caller, 'rotated-files', true);
		const fileId = await sendFile(caller, uploadToken, channelId, 'rotated.txt');
		const [before] = await caller.files.refreshAccessTokens({ fileIds: [fileId] });

		await caller.channels.rotateFileAccessToken({ channelId });

		const [after] = await caller.files.refreshAccessTokens({ fileIds: [fileId] });

		expect(after?.accessToken).not.toBe(before?.accessToken);
		expect(verifyFileToken(fileId, await getChannelFileAccessToken(channelId), after?.accessToken ?? '')).toBe(true);
	});

	test('leaves out files in private channels the caller cannot view', async () => {
		const { caller: ownerCaller } = await initTest(OWNER_ID);
		const { caller: memberCaller } = await initTest(MEMBER_ID);
		const uploadToken = await getOwnerUploadToken();
		const staffChannelId = await addTextChannel(ownerCaller, 'staff', true);
		const staffFileId = await sendFile(ownerCaller, uploadToken, staffChannelId, 'staff.txt');
		const publicFileId = await sendFile(ownerCaller, uploadToken, 1, 'public.txt');

		const tokens = await memberCaller.files.refreshAccessTokens({ fileIds: [staffFileId, publicFileId] });

		expect(tokens.map(({ fileId }) => fileId)).toEqual([publicFileId]);
	});

	test('leaves out unknown IDs and files that are not attachments', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const avatarId = await uploadAvatar(caller, uploadToken);

		expect(await caller.files.refreshAccessTokens({ fileIds: [avatarId, 99_999] })).toEqual([]);
		expect(await caller.files.refreshAccessTokens({ fileIds: [] })).toEqual([]);
	});

	test('refuses more than 100 file IDs', async () => {
		const { caller } = await initTest(OWNER_ID);
		const fileIds = Array.from({ length: 101 }, (_, index) => index + 1);

		await expect(caller.files.refreshAccessTokens({ fileIds })).rejects.toThrow();
		expect(await caller.files.refreshAccessTokens({ fileIds: fileIds.slice(0, 100) })).toEqual([]);
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

	test('leaves out private channel files the caller cannot view and signs the rest', async () => {
		const { caller: ownerCaller, initialData } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const privateChannelId = await addTextChannel(ownerCaller, 'secret', true);
		const privateFileId = await sendFile(ownerCaller, uploadToken, privateChannelId, 'secret-plans.txt');
		const publicFileId = await sendFile(ownerCaller, uploadToken, 1, 'public-notes.txt');

		await grantMemberManageUsers(ownerCaller, initialData.roles);

		const { caller: moderatorCaller } = await initTest(MEMBER_ID);
		const { files } = await moderatorCaller.users.getInfo({ userId: OWNER_ID });

		expect(files.map((file) => file.id)).toEqual([publicFileId]);
		expect(files.some((file) => file.id === privateFileId)).toBe(false);
		expect(verifyFileToken(publicFileId, await getChannelFileAccessToken(1), files[0]?._accessToken ?? '')).toBe(true);
	});

	test('signs private channel files the caller can view and leaves other files unsigned', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const privateChannelId = await addTextChannel(caller, 'secret', true);
		const privateFileId = await sendFile(caller, uploadToken, privateChannelId, 'secret-plans.txt');
		const avatarId = await uploadAvatar(caller, uploadToken);

		const { files } = await caller.users.getInfo({ userId: OWNER_ID });
		const privateFile = files.find((file) => file.id === privateFileId);
		const avatar = files.find((file) => file.id === avatarId);

		expect(
			verifyFileToken(
				privateFileId,
				await getChannelFileAccessToken(privateChannelId),
				privateFile?._accessToken ?? '',
			),
		).toBe(true);
		expect(avatar).toBeDefined();
		expect(avatar?._accessToken).toBeUndefined();
	});
});

describe('message attachments', () => {
	test('are signed in public channels too', async () => {
		const { caller } = await initTest(OWNER_ID);
		const uploadToken = await getOwnerUploadToken();
		const fileId = await sendFile(caller, uploadToken, 1, 'public.txt');
		const { messages } = await caller.messages.get({ channelId: 1 });
		const file = messages.flatMap((message) => message.files).find((candidate) => candidate.id === fileId);

		expect(verifyFileToken(fileId, await getChannelFileAccessToken(1), file?._accessToken ?? '')).toBe(true);
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

	test('channel updates, private toggles included, publish nothing', async () => {
		const { caller } = await initTest(OWNER_ID);
		const channelId = await addTextChannel(caller, 'toggled', false);
		const events = recordFileAccessEvents([OWNER_ID, MEMBER_ID]);

		try {
			// Every attachment is already signed, so a toggle leaves held tokens valid.
			await caller.channels.update({ channelId, private: true });
			await caller.channels.update({ channelId, private: false });
			await caller.channels.update({ channelId, topic: 'new topic' });

			expect(events.received).toEqual({ [OWNER_ID]: [], [MEMBER_ID]: [] });
		} finally {
			events.stop();
		}
	});
});
