import { expect, test } from '@playwright/test';
import {
	dropWsShort,
	installPcHook,
	joinVoice,
	leaveVoice,
	login,
	pcStats,
	startCamera,
	waitForStats,
} from '../helpers/app';

// Single-peer reconnect: exercises the transport/producer restore path in
// use-transports.ts + trpc.ts + ws-reconnect-gate.ts (all reworked in #274).
// A WS drop under 60s must self-heal without dropping the user from voice or
// killing their live camera producer.
//
// Uses "Gaming Room" (two-peer uses "Lounge") so the two specs never share voice
// state, and leaves voice cleanly at the end so no participant lingers through the
// 60s reconnect grace and pollutes a later run.
test('local camera survives a short WS drop', async ({ page, context }) => {
	await installPcHook(context);
	await login(page, 'sharkord', 'sharkord');
	await joinVoice(page, 'Gaming Room');
	try {
		await startCamera(page);
		await waitForStats(page, (s) => s.outboundVideoBytes > 0, 'local camera to start sending');

		// Confirm the stream is genuinely live (bytes climbing), not a frozen frame.
		const before = await pcStats(page);
		await page.waitForTimeout(2000);
		const flowing = await pcStats(page);
		expect(flowing.outboundVideoBytes).toBeGreaterThan(before.outboundVideoBytes);

		// Fault: drop the websocket for <60s and let the client auto-restore.
		await dropWsShort(page);

		// Still in voice after the reconnect settles.
		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

		// The camera producer resumes sending after restore (measure a fresh delta so
		// we're proving live flow post-reconnect, not reading stale pre-drop totals).
		const post1 = await pcStats(page);
		await waitForStats(
			page,
			(s) => s.outboundVideoBytes > post1.outboundVideoBytes,
			'camera to resume sending after reconnect',
			30_000,
		);

		// No error surfaced to the user.
		await expect(page.getByText(/failed to reconnect|connection lost/i)).toHaveCount(0);
	} finally {
		await leaveVoice(page).catch(() => {});
	}
});
