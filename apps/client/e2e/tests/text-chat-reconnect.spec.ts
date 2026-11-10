import { expect, test } from '@playwright/test';
import { createPeer, credentialsFor, disposePeer, login, suppressViteHmrReload } from '../helpers/app';
import { installServerUnreachableFault } from '../helpers/server-unreachable';
import { messageContent, openTextChannel, sendMessage } from '../helpers/text-chat';

test('the open text channel catches up after a silent reconnect and preserves its draft', async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const fault = await installServerUnreachableFault(page);
	const writer = await createPeer(browser, credentialsFor(testInfo, 'writer'));
	const id = crypto.randomUUID().slice(0, 8);
	const draft = `Unsent draft ${id}`;
	const messages = [1, 2, 3].map((index) => `Missed message ${index} ${id}`);

	try {
		await login(page, credentialsFor(testInfo, 'reader'));
		await openTextChannel(page, 'General Text');
		await openTextChannel(writer.page, 'General Text');
		const composer = page
			.locator('div')
			.filter({ has: page.getByTitle('Send message') })
			.filter({ has: page.getByRole('textbox') })
			.last()
			.getByRole('textbox');
		await composer.fill(draft);

		// Record even a transient disconnect screen during the entire outage and recovery.
		await page.evaluate(() => {
			const observer = new MutationObserver(() => {
				if (document.body.textContent?.includes('Connection lost')) {
					document.documentElement.setAttribute('data-e2e-connection-lost', 'true');
				}
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		});
		const startedAt = Date.now();
		await fault.cut();
		for (const message of messages) await sendMessage(writer.page, message);
		fault.restore();
		expect(Date.now() - startedAt).toBeLessThan(10_000);

		// Regression assertion: unmodified main never loads these missed messages.
		for (const message of messages) await expect(messageContent(page, message)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText('Connection lost', { exact: true })).toHaveCount(0);
		await expect(page.locator('html')).not.toHaveAttribute('data-e2e-connection-lost', 'true');
		await expect(
			page.getByRole('button', { name: 'General Text', exact: true }).locator('span.rounded-full'),
		).toHaveCount(0);
		await expect(composer).toHaveText(draft);

		await openTextChannel(page, 'General Text 2');
		await openTextChannel(page, 'General Text');
		for (const message of messages) await expect(messageContent(page, message)).toHaveCount(1);
	} finally {
		fault.restore();
		await context.close();
		await disposePeer(writer);
	}
});
