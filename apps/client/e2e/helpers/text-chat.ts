import { expect, type Locator, type Page } from '@playwright/test';

type UploadFile = {
	name: string;
	mimeType: string;
	buffer: Buffer;
};

// A 3×2 RGB PNG. Its decoded width proves the browser received the real file,
// not a placeholder or an error body.
const PIXEL_PNG_WIDTH = 3;
const PIXEL_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGO4o6EBQQxwFgBKnAcJpT391QAAAABJRU5ErkJggg==';

const pixelPng = (name: string): UploadFile => ({
	name,
	mimeType: 'image/png',
	buffer: Buffer.from(PIXEL_PNG_BASE64, 'base64'),
});

const textFile = (name: string, content: string): UploadFile => ({
	name,
	mimeType: 'text/plain',
	buffer: Buffer.from(content),
});

// The channel composer, not an inline message editor: the deepest element that
// holds both an editor and the send button.
const messageComposer = (page: Page): Locator =>
	page
		.locator('div')
		.filter({ has: page.getByTitle('Send message') })
		.filter({ has: page.getByRole('textbox') })
		.last()
		.getByRole('textbox');

const exactText = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const openTextChannel = async (page: Page, channelName: string): Promise<void> => {
	await page.getByRole('button', { name: channelName, exact: true }).click();
	// The channel header names the open channel.
	await expect(page.locator('span.font-semibold', { hasText: exactText(channelName) })).toBeVisible();
	await expect(messageComposer(page)).toBeEditable();
};

const messageContent = (page: Page, text: string): Locator => page.locator('.msg-content').filter({ hasText: text });

// The rendered message: its text, attachments and reactions.
const messageBody = (page: Page, text: string): Locator => messageContent(page, text).locator('xpath=..');

// The hoverable message row that owns the edit and delete actions.
const messageRow = (page: Page, text: string): Locator => messageContent(page, text).locator('xpath=../..');

const sendMessage = async (page: Page, text: string): Promise<void> => {
	const composer = messageComposer(page);
	await composer.click();
	await composer.pressSequentially(text);
	await composer.press('Enter');
	await expect(messageContent(page, text)).toBeVisible();
	await expect(composer).toHaveText('');
};

const editMessage = async (page: Page, from: string, to: string): Promise<void> => {
	const row = messageRow(page, from);
	await row.hover();
	await row.getByTitle('Edit Message').click();

	const editor = page
		.locator('div')
		.filter({ has: page.getByText('Press Enter to save, Esc to cancel') })
		.last()
		.getByRole('textbox');
	await expect(editor).toHaveText(from);
	await editor.press('ControlOrMeta+a');
	await editor.pressSequentially(to);
	await editor.press('Enter');

	await expect(messageContent(page, to)).toBeVisible();
	await expect(messageContent(page, from)).toHaveCount(0);
};

const deleteMessage = async (page: Page, text: string): Promise<void> => {
	const row = messageRow(page, text);
	await row.hover();
	await row.getByTitle('Delete Message').click();

	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toContainText('Delete Message');
	await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(messageContent(page, text)).toHaveCount(0);
};

const attachFiles = async (page: Page, files: UploadFile[]): Promise<void> => {
	const fileChooser = page.waitForEvent('filechooser');
	await page.getByTitle('Upload files').click();
	await (await fileChooser).setFiles(files);

	await expect(page.getByText(/^Uploading files/)).toHaveCount(0, { timeout: 30_000 });
	for (const file of files) {
		await expect(page.getByText(file.name, { exact: true })).toBeVisible();
	}
};

const expectImageDecoded = async (body: Locator, width = PIXEL_PNG_WIDTH): Promise<void> => {
	const image = body.locator('img').first();
	await expect
		.poll(
			() =>
				image.evaluate((element) =>
					element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
				),
			{ message: 'attached image to decode', timeout: 20_000 },
		)
		.toBe(width);
};

const fileCardHref = async (body: Locator, fileName: string): Promise<string> => {
	const href = await body.getByRole('link', { name: fileName }).getAttribute('href');
	if (!href) {
		throw new Error(`The ${fileName} card has no link`);
	}

	return href;
};

export type { UploadFile };
export {
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
};
