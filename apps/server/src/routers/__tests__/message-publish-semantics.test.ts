import { afterEach, describe, expect, test } from 'bun:test';
import { ServerEvents, type TJoinedMessage } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { files, messageFiles, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

const subscriptions: { unsubscribe: () => void }[] = [];

afterEach(() => {
	for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
});

const observeMessages = (userId: number) => {
	const created: TJoinedMessage[] = [];
	const updated: TJoinedMessage[] = [];
	const deltas: { channelId: number; delta: number }[] = [];
	subscriptions.push(
		pubsub.subscribeFor(userId, ServerEvents.NEW_MESSAGE).subscribe({
			next: (message) => {
				created.push(message);
			},
		}),
		pubsub.subscribeFor(userId, ServerEvents.MESSAGE_UPDATE).subscribe({
			next: (message) => {
				updated.push(message);
			},
		}),
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_READ_STATES_DELTA).subscribe({
			next: (delta) => {
				deltas.push(delta);
			},
		}),
	);
	return { created, updated, deltas };
};

// Route publishers run asynchronously; wait for their positive delivery signal.
const waitFor = async (condition: () => boolean) => {
	const deadline = Date.now() + 2000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for message publication');
		await Bun.sleep(5);
	}
};

describe('message publish semantics', () => {
	test('a new message increments only the other viewer unread count', async () => {
		const { caller } = await initTest(1);
		await initTest(2);
		const author = observeMessages(1);
		const viewer = observeMessages(2);
		const messageId = await caller.messages.send({ channelId: 1, content: 'New message', files: [] });

		await waitFor(() => viewer.created.length === 1 && viewer.deltas.length === 1);
		expect(viewer.created[0]?.id).toBe(messageId);
		expect(author.created[0]?.id).toBe(messageId);
		expect(viewer.deltas).toEqual([{ channelId: 1, delta: 1 }]);
		expect(author.deltas).toEqual([]);
	});

	test('an edit reaches viewers without adding another unread', async () => {
		const { caller } = await initTest(1);
		await initTest(2);
		const viewer = observeMessages(2);
		const messageId = await caller.messages.send({ channelId: 1, content: 'Original', files: [] });
		await waitFor(() => viewer.deltas.length === 1);

		await caller.messages.edit({ messageId, content: 'Edited' });
		await waitFor(() => viewer.updated.length === 1);
		expect(viewer.updated[0]?.content).toBe('Edited');
		expect(viewer.deltas).toEqual([{ channelId: 1, delta: 1 }]);
	});

	test('toggling a reaction on and off reaches the author without unread deltas', async () => {
		const { caller: authorCaller } = await initTest(1);
		const { caller: reactorCaller } = await initTest(2);
		const author = observeMessages(1);
		const reactor = observeMessages(2);
		const messageId = await authorCaller.messages.send({ channelId: 1, content: 'React here', files: [] });
		await waitFor(() => reactor.deltas.length === 1);

		await reactorCaller.messages.toggleReaction({ messageId, emoji: '👍' });
		await waitFor(() => author.updated.length === 1 && reactor.updated.length === 1);
		expect(author.updated[0]?.reactions).toHaveLength(1);
		await reactorCaller.messages.toggleReaction({ messageId, emoji: '👍' });
		await waitFor(() => author.updated.length === 2 && reactor.updated.length === 2);
		expect(author.updated[1]?.reactions).toEqual([]);
		expect(author.deltas).toEqual([]);
		expect(reactor.deltas).toEqual([{ channelId: 1, delta: 1 }]);
	});

	test('deleting an attachment preserves text and publishes an update without unread deltas', async () => {
		const { caller } = await initTest(1);
		await initTest(2);
		const viewer = observeMessages(2);
		const messageId = await caller.messages.send({ channelId: 1, content: 'Keep this text', files: [] });
		await waitFor(() => viewer.deltas.length === 1);
		const file = tdb
			.insert(files)
			.values({
				name: 'publish-semantics.txt',
				originalName: 'attachment.txt',
				md5: 'test-fixture',
				extension: 'txt',
				size: 4,
				mimeType: 'text/plain',
				userId: 1,
				createdAt: Date.now(),
			})
			.returning()
			.get();
		tdb.insert(messageFiles).values({ messageId, fileId: file.id, createdAt: Date.now() }).run();

		await caller.files.delete({ fileId: file.id });
		await waitFor(() => viewer.updated.length === 1);
		expect(viewer.updated[0]?.id).toBe(messageId);
		expect(viewer.updated[0]?.content).toBe('Keep this text');
		expect(viewer.updated[0]?.files).toEqual([]);
		expect(viewer.deltas).toEqual([{ channelId: 1, delta: 1 }]);
	});

	test('the metadata job stores previews without setting the edit timestamp', async () => {
		const { caller } = await initTest(1);
		const messageId = await caller.messages.send({ channelId: 1, content: 'No external link needed', files: [] });
		const readMessage = () => tdb.select().from(messages).where(eq(messages.id, messageId)).get();
		await waitFor(() => readMessage()?.metadata != null);
		expect(readMessage()?.metadata).toEqual([]);
		expect(readMessage()?.updatedAt).toBeNull();
	});
});
