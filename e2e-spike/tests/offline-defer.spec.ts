import { expect, test } from '@playwright/test';
import { installPcHook, joinVoice, leaveVoice, login, pcStats, startCamera, waitForStats } from '../helpers/app';

// Real browser offline (navigator.onLine=false + socket death) — distinct from
// ReconnectLab's synthetic offline. Exercises ws-reconnect-gate.ts
// (shouldDeferAppTeardownWhileOffline): while offline and within the grace, the
// voice session must NOT be torn down; when connectivity returns it must recover.
// This is the "keep reconnect teardown pending while offline" commit.
test('voice teardown is deferred while offline, then recovers online', async ({ page, context }) => {
	test.setTimeout(90_000);
	await installPcHook(context);
	await login(page, 'sharkord', 'sharkord');
	await joinVoice(page, 'Work Mode');
	try {
		await startCamera(page);
		await waitForStats(page, (s) => s.outboundVideoBytes > 0, 'camera to start sending');

		// Go offline for well under the 60s grace.
		await context.setOffline(true);
		await page.waitForTimeout(8000);

		// Teardown must be DEFERRED — the user is still in the voice session (the
		// leave control is still present), not dumped back to the channel list.
		await expect(page.getByTitle('Leave voice')).toBeVisible();

		// Back online — the client resumes the deferred reconnect.
		await context.setOffline(false);
		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

		// Camera resumes sending after recovery (fresh delta = proven live flow).
		const post = await pcStats(page);
		await waitForStats(
			page,
			(s) => s.outboundVideoBytes > post.outboundVideoBytes,
			'camera to resume after coming back online',
			30_000,
		);
	} finally {
		await context.setOffline(false).catch(() => {});
		await leaveVoice(page).catch(() => {});
	}
});
