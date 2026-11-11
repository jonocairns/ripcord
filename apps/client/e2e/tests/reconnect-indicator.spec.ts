import { expect, test } from '@playwright/test';
import { credentialsFor, login, suppressViteHmrReload } from '../helpers/app';
import { installServerUnreachableFault } from '../helpers/server-unreachable';
import { messageContent, openTextChannel, sendMessage } from '../helpers/text-chat';

test('a text-only user sees recovery status until the server session rejoins', async ({ browser }, testInfo) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const fault = await installServerUnreachableFault(page);
	try {
		await login(page, credentialsFor(testInfo, 'reader'));
		await openTextChannel(page, 'General Text');
		await fault.cut();

		// Fail-on-main proof: the baseline must fail here, not during setup.
		const status = page.getByRole('status').filter({ hasText: 'Reconnecting...' });
		await expect(status).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText('Connection lost', { exact: true })).toHaveCount(0);
		fault.restore();
		await expect(status).toHaveCount(0, { timeout: 20_000 });
		const message = `Rejoined text session ${crypto.randomUUID()}`;
		await sendMessage(page, message);
		await expect(messageContent(page, message)).toBeVisible();
	} finally {
		fault.restore();
		await context.close();
	}
});
