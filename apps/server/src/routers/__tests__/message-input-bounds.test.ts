import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { db } from '../../db';
import { messages } from '../../db/schema';
import { selectPreviewUrls } from '../../queues/message-metadata/get-message-metadata';

const TOO_LONG_MESSAGE = 'Message is too long. The limit is 4000 characters.';
const paragraphs = (length: number) => '<p>x</p>'.repeat(length);

describe('message input bounds', () => {
	test('send accepts 4000 characters in paragraphs and rejects 4001 without storing them', async () => {
		const { caller } = await initTest();
		const content = paragraphs(4000);
		const messageId = await caller.messages.send({ channelId: 1, content, files: [] });
		expect(db.select().from(messages).where(eq(messages.id, messageId)).get()?.content).toBe(content);

		const storedCount = db.select().from(messages).all().length;
		await expect(
			caller.messages.send({
				channelId: 1,
				content: paragraphs(4001),
				files: [],
			}),
		).rejects.toMatchObject({ code: 'BAD_REQUEST', message: TOO_LONG_MESSAGE });
		expect(db.select().from(messages).all()).toHaveLength(storedCount);
	});

	test('edit accepts 4000 characters in paragraphs and preserves content after rejecting 4001', async () => {
		const { caller } = await initTest();
		const messageId = await caller.messages.send({ channelId: 1, content: 'original', files: [] });
		const content = paragraphs(4000);
		await caller.messages.edit({ messageId, content });
		await expect(caller.messages.edit({ messageId, content: paragraphs(4001) })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			message: TOO_LONG_MESSAGE,
		});
		expect(db.select().from(messages).where(eq(messages.id, messageId)).get()?.content).toBe(content);
	});

	test('send and edit reject raw HTML above 40000 even with short text', async () => {
		const { caller } = await initTest();
		const content = `<p title="${'x'.repeat(40000)}">x</p>`;
		const messageId = await caller.messages.send({ channelId: 1, content: 'original', files: [] });
		await expect(caller.messages.send({ channelId: 1, content, files: [] })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			message: TOO_LONG_MESSAGE,
		});
		await expect(caller.messages.edit({ messageId, content })).rejects.toMatchObject({
			code: 'BAD_REQUEST',
			message: TOO_LONG_MESSAGE,
		});
		expect(db.select().from(messages).where(eq(messages.id, messageId)).get()?.content).toBe('original');
	});

	test('measures sanitized text and decoded entities rather than HTML length', async () => {
		const { caller } = await initTest();
		const content = `<p>${'&amp;'.repeat(4000)}</p><script>removed</script>`;
		const messageId = await caller.messages.send({ channelId: 1, content, files: [] });
		await caller.messages.edit({ messageId, content });
		expect(db.select().from(messages).where(eq(messages.id, messageId)).get()?.content).toBe(
			`<p>${'&amp;'.repeat(4000)}</p>`,
		);
	});

	test('reaction names must contain between 1 and 128 characters', async () => {
		const { caller } = await initTest();
		const messageId = await caller.messages.send({ channelId: 1, content: 'reaction target', files: [] });
		for (const emoji of ['', 'x'.repeat(129)]) {
			await expect(caller.messages.toggleReaction({ messageId, emoji })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		}
		await caller.messages.toggleReaction({ messageId, emoji: 'x'.repeat(128) });
	});

	test('reaction toggles are limited to 120 per minute', async () => {
		const { caller } = await initTest();
		const messageId = await caller.messages.send({ channelId: 1, content: 'reaction target', files: [] });
		for (let i = 0; i < 120; i++) {
			await caller.messages.toggleReaction({ messageId, emoji: '👍' });
		}
		await expect(caller.messages.toggleReaction({ messageId, emoji: '👍' })).rejects.toMatchObject({
			code: 'TOO_MANY_REQUESTS',
		});
	});

	test('selects only the first five distinct preview URLs', () => {
		const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`);
		const content = [urls[0], urls[0], ...urls].join(' ');
		expect(selectPreviewUrls(content)).toEqual(urls.slice(0, 5));
		expect(selectPreviewUrls('no links')).toEqual([]);
	});

	test('preview selection ignores custom emoji images', () => {
		const emoji = Array.from(
			{ length: 6 },
			(_, i) =>
				`<img src="https://chat.example/public/emoji-${i}.png?accessToken=t" data-type="emoji" data-name="e${i}" />`,
		).join('');
		const content = `<p>${emoji} <a href="https://youtube.com/watch?v=abc">https://youtube.com/watch?v=abc</a></p>`;
		expect(selectPreviewUrls(content)).toEqual(['https://youtube.com/watch?v=abc']);
	});
});
