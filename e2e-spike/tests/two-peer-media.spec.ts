import { type Browser, expect, test } from '@playwright/test';
import {
	dropWsShort,
	installPcHook,
	joinVoice,
	leaveVoice,
	login,
	pcStats,
	remoteCameraIndicator,
	startCamera,
	stopCamera,
	waitForStats,
	watchRemoteCamera,
} from '../helpers/app';
import { E2E_PEER } from '../helpers/peer-creds';

async function newPeer(browser: Browser) {
	const context = await browser.newContext();
	await installPcHook(context);
	const page = await context.newPage();
	return { context, page };
}

// Two-peer remote media — the heart of #274's subscription ledger:
//   • presence → consume → visible  (visibleRemoteMedia selector)
//   • watch intent restored across a WS reconnect
//   • sharer stops → the watcher's slot clears (no stuck/failed card)
//
// Both peers must be voice-capable; only owners are in this dev DB, so A is the
// bootstrap owner (jono) and B is the seeded Owner e2e peer.
test('A watches B camera across a reconnect, and clears when B stops', async ({ browser }) => {
	test.setTimeout(180_000);
	const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

	const a = await newPeer(browser);
	const b = await newPeer(browser);

	try {
		await login(a.page, 'sharkord', 'sharkord');
		await login(b.page, E2E_PEER.identity, E2E_PEER.password);

		await joinVoice(a.page, 'Lounge');
		await joinVoice(b.page, 'Lounge');
		log('both joined');

		// B publishes camera. A sees the "live camera" indicator on B's row, then
		// clicks it to watch — that click is the ledger's watch intent.
		await startCamera(b.page);
		await waitForStats(b.page, (s) => s.outboundVideoBytes > 0, 'B camera to send');
		await watchRemoteCamera(a.page);
		const consumed = await waitForStats(a.page, (s) => s.inboundVideoBytes > 0, 'A to consume B camera', 30_000);
		expect(consumed.inboundVideoTracks).toBeGreaterThan(0);
		log('A is consuming B camera');

		// Fault: A drops its websocket. #274 must restore the watch intent so A
		// re-consumes B's camera rather than going dark.
		await dropWsShort(a.page);
		await expect(a.page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		const afterReconnect = await pcStats(a.page);
		await waitForStats(
			a.page,
			(s) => s.inboundVideoBytes > afterReconnect.inboundVideoBytes,
			'A to resume consuming B after reconnect (watch intent restored)',
			40_000,
		);
		log('A resumed consuming B after reconnect');

		// B stops sharing. A's inbound video must go quiet and the slot must clear —
		// no stuck "failed camera" card (the exact bug fixed on this branch).
		await stopCamera(b.page);
		// B's camera indicator disappears on A (the exact "no stuck card" surface).
		await expect(remoteCameraIndicator(a.page)).toHaveCount(0, { timeout: 20_000 });
		const atStop = await pcStats(a.page);
		await a.page.waitForTimeout(4000);
		const afterStop = await pcStats(a.page);
		expect(afterStop.inboundVideoBytes - atStop.inboundVideoBytes).toBeLessThan(50_000);
		await expect(a.page.getByText(/camera.*(failed|unavailable)/i)).toHaveCount(0);
		log('B stop propagated; A slot clear');
	} finally {
		// Leave voice cleanly so neither peer lingers through the 60s reconnect grace
		// and pollutes the next run with a ghost participant.
		await leaveVoice(a.page).catch(() => {});
		await leaveVoice(b.page).catch(() => {});
		await a.context.close();
		await b.context.close();
	}
});
