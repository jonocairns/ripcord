import { expect, test } from '@playwright/test';
import { createPeer, credentialsFor, disposePeer, dropAppWebSocket, joinVoice } from '../helpers/app';

test('a genuine same-user takeover clears only the stale local session', async ({ browser }, testInfo) => {
	test.setTimeout(120_000);
	const credentials = credentialsFor(testInfo, 'shared-user');
	const stalePeer = await createPeer(browser, credentials);
	const activePeer = await createPeer(browser, credentials);

	try {
		await joinVoice(stalePeer.page);
		await dropAppWebSocket(stalePeer.page, { waitForReconnect: false });
		await joinVoice(activePeer.page);

		await expect(stalePeer.page.getByText(/taken over by another connection/i)).toBeVisible({ timeout: 30_000 });
		await expect(stalePeer.page.getByTitle('Leave voice')).toHaveCount(0, { timeout: 15_000 });
		await stalePeer.page.waitForTimeout(4_000);
		await expect(stalePeer.page.getByText('Reconnecting voice...')).toHaveCount(0);

		await expect(stalePeer.page.getByText('VOICE CHANNELS')).toBeVisible();
		await expect(activePeer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(activePeer.page.getByTitle('Leave voice')).toBeVisible();
	} finally {
		await disposePeer(stalePeer);
		await disposePeer(activePeer);
	}
});
