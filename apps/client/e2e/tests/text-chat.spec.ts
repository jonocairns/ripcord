import { expect, test } from '@playwright/test';
import { createPeer, credentialsFor, disposePeer, OWNER_CREDENTIALS } from '../helpers/app';
import {
	attachFiles,
	deleteMessage,
	editMessage,
	expectImageDecoded,
	fileCardHref,
	messageBody,
	messageContent,
	messageRow,
	openTextChannel,
	pixelPng,
	sendMessage,
	textFile,
} from '../helpers/text-chat';
import { callTrpc } from '../helpers/trpc';

const TEXT_CHANNEL = 'General Text';
const ATTACHMENT_CHANNEL = 'General Text 2';
const TEXT_CHANNELS_CATEGORY_ID = 1;

// The suite shares one server per run, so every message and file name carries
// a per-test nonce.
const nonce = (): string => crypto.randomUUID().slice(0, 8);

test('a sent message reaches another member live and follows its edit and delete', async ({ browser }, testInfo) => {
	const author = await createPeer(browser, credentialsFor(testInfo, 'author'));
	const reader = await createPeer(browser, credentialsFor(testInfo, 'reader'));
	const id = nonce();
	const original = `Hello from the author ${id}`;
	const edited = `Edited by the author ${id}`;

	try {
		await openTextChannel(author.page, TEXT_CHANNEL);
		await openTextChannel(reader.page, TEXT_CHANNEL);

		await sendMessage(author.page, original);
		await expect(messageContent(reader.page, original)).toBeVisible();

		// Members manage only their own messages.
		await messageRow(reader.page, original).hover();
		await expect(reader.page.getByTitle('Edit Message')).toHaveCount(0);
		await expect(reader.page.getByTitle('Delete Message')).toHaveCount(0);

		await editMessage(author.page, original, edited);
		await expect(messageContent(reader.page, edited)).toBeVisible();
		await expect(messageContent(reader.page, original)).toHaveCount(0);

		await deleteMessage(author.page, edited);
		await expect(messageContent(reader.page, edited)).toHaveCount(0);
	} finally {
		await disposePeer(author);
		await disposePeer(reader);
	}
});

test('attachments reach live and late readers and are removed with their message', async ({ browser }, testInfo) => {
	const author = await createPeer(browser, credentialsFor(testInfo, 'author'));
	const reader = await createPeer(browser, credentialsFor(testInfo, 'reader'));
	const id = nonce();
	const caption = `Attachments ${id}`;
	const image = pixelPng(`pixel-${id}.png`);
	const notesContent = `Release notes ${id}`;
	const notes = textFile(`notes-${id}.txt`, notesContent);

	try {
		await openTextChannel(author.page, ATTACHMENT_CHANNEL);
		await openTextChannel(reader.page, ATTACHMENT_CHANNEL);

		await attachFiles(author.page, [image, notes]);
		await sendMessage(author.page, caption);
		await expectImageDecoded(messageBody(author.page, caption));

		const liveBody = messageBody(reader.page, caption);
		await expectImageDecoded(liveBody);
		const notesUrl = await fileCardHref(liveBody, notes.name);
		const download = await reader.page.request.get(notesUrl);
		expect(download.status()).toBe(200);
		expect(await download.text()).toBe(notesContent);

		// A reader who arrives later gets the attachments from message history.
		const lateReader = await createPeer(browser, credentialsFor(testInfo, 'late-reader'));
		try {
			await openTextChannel(lateReader.page, ATTACHMENT_CHANNEL);
			const historyBody = messageBody(lateReader.page, caption);
			await expectImageDecoded(historyBody);
			const historyDownload = await lateReader.page.request.get(await fileCardHref(historyBody, notes.name));
			expect(historyDownload.status()).toBe(200);
			expect(await historyDownload.text()).toBe(notesContent);
		} finally {
			await disposePeer(lateReader);
		}

		await deleteMessage(author.page, caption);
		await expect(messageContent(reader.page, caption)).toHaveCount(0);
		expect((await reader.page.request.get(notesUrl)).status()).toBe(404);
	} finally {
		await disposePeer(author);
		await disposePeer(reader);
	}
});

test('private channel attachment links need a current channel token', async ({ browser }, testInfo) => {
	const owner = await createPeer(browser, OWNER_CREDENTIALS);
	const member = await createPeer(browser, credentialsFor(testInfo, 'member'));
	const id = nonce();
	const channelName = `private-${id}`;
	const caption = `Private attachment ${id}`;
	let channelId: number | undefined;

	try {
		const createdId = await callTrpc(owner.page, {
			path: ['channels', 'add'],
			method: 'mutate',
			input: { type: 'TEXT', name: channelName, categoryId: TEXT_CHANNELS_CATEGORY_ID },
		});
		if (typeof createdId !== 'number') {
			throw new Error('channels.add did not return a channel id');
		}
		channelId = createdId;
		const memberChannel = member.page.getByRole('button', { name: channelName, exact: true });
		await expect(memberChannel).toBeVisible();

		await callTrpc(owner.page, {
			path: ['channels', 'update'],
			method: 'mutate',
			input: { channelId, private: true },
		});
		await expect(memberChannel).toHaveCount(0);

		await openTextChannel(owner.page, channelName);
		await attachFiles(owner.page, [pixelPng(`private-${id}.png`)]);
		await sendMessage(owner.page, caption);

		const body = messageBody(owner.page, caption);
		await expectImageDecoded(body);
		const openLink = body.getByRole('link', { name: 'Open in new tab' });
		const signedUrl = await openLink.getAttribute('href');
		if (!signedUrl) {
			throw new Error('The private attachment has no link');
		}

		const unsignedUrl = new URL(signedUrl);
		expect(unsignedUrl.searchParams.has('accessToken')).toBe(true);
		unsignedUrl.searchParams.delete('accessToken');
		expect((await owner.page.request.get(signedUrl)).status()).toBe(200);
		expect((await owner.page.request.get(unsignedUrl.toString())).status()).toBe(403);

		// Rotating the channel token revokes old links; the open client re-signs
		// the links it holds.
		await callTrpc(owner.page, {
			path: ['channels', 'rotateFileAccessToken'],
			method: 'mutate',
			input: { channelId },
		});
		await expect.poll(async () => (await owner.page.request.get(signedUrl)).status()).toBe(403);
		await expect(openLink).not.toHaveAttribute('href', signedUrl);
		const resignedUrl = await openLink.getAttribute('href');
		if (!resignedUrl) {
			throw new Error('The private attachment lost its link after rotation');
		}
		expect((await owner.page.request.get(resignedUrl)).status()).toBe(200);
		await expectImageDecoded(body);
	} finally {
		if (channelId !== undefined) {
			await callTrpc(owner.page, {
				path: ['channels', 'delete'],
				method: 'mutate',
				input: { channelId },
			}).catch(() => {});
		}
		await disposePeer(owner);
		await disposePeer(member);
	}
});
