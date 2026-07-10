import { expect, test } from '@playwright/test';
import {
	installPcHook,
	joinVoice,
	leaveVoice,
	login,
	startCamera,
	suppressViteHmrReload,
	waitForStats,
} from '../helpers/app';

// Grace BOUNDARY: go offline for longer than the 60s reconnect grace. Past the
// window the session can no longer be silently restored, so the client must land
// in a coherent state (usable app, no stuck error/crash) once connectivity
// returns — the other side of the "<60s drop survives" case.
//
// Slow by nature (must exceed 60s of real time); run it on demand, not every loop.
test('offline beyond the 60s grace recovers to a coherent state', async ({ page, context }) => {
	test.setTimeout(150_000);
	await installPcHook(context);
	// Vite's dev client reloads the page after offline windows — suppress so we
	// observe the app's own recovery, not a dev-harness artifact.
	await suppressViteHmrReload(page);
	await login(page, 'sharkord', 'sharkord');
	await joinVoice(page, 'Work Mode');
	try {
		await startCamera(page);
		await waitForStats(page, (s) => s.outboundVideoBytes > 0, 'camera to start sending');

		// Exceed the 60s grace.
		await context.setOffline(true);
		await page.waitForTimeout(65_000);
		await context.setOffline(false);

		// The socket must recover and the app must be usable again.
		await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 45_000 });

		// Observed-correct behaviour: past the grace the client still fully recovers —
		// it reconnects AND re-establishes the voice session (does not strand the user
		// out of voice or in a broken half-state).
		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTitle('Leave voice')).toBeVisible();

		// No fatal/stuck error surfaced to the user.
		await expect(page.getByText(/failed to reconnect|something went wrong/i)).toHaveCount(0);
	} finally {
		await context.setOffline(false).catch(() => {});
		await leaveVoice(page).catch(() => {});
	}
});
