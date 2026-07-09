import { type Browser, expect, test } from '@playwright/test';
import {
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
	return { context, page: await context.newPage() };
}

// Producer replace — the "reset replaced remote producers" commit on this branch.
// While A is watching B, B's camera producer is torn down and a NEW one is
// published. A must end up consuming the *new* producer with live video — no dead
// consumer, no stuck "failed camera" card.
//
// Note: driven through the UI (stop → start), so A may either auto-reconsume under
// the retained watch intent or re-watch the fresh indicator. Either way the
// user-visible contract is the same: A recovers to a live stream.
test('A recovers to live video when B replaces its camera producer', async ({ browser }) => {
	test.setTimeout(120_000);
	const a = await newPeer(browser);
	const b = await newPeer(browser);

	try {
		await login(a.page, 'sharkord', 'sharkord');
		await login(b.page, E2E_PEER.identity, E2E_PEER.password);
		await joinVoice(a.page, 'Lounge');
		await joinVoice(b.page, 'Lounge');

		await startCamera(b.page);
		await waitForStats(b.page, (s) => s.outboundVideoBytes > 0, 'B camera to send');
		await watchRemoteCamera(a.page);
		await waitForStats(a.page, (s) => s.inboundVideoBytes > 0, 'A to consume B camera (first producer)');

		// Replace: tear down B's producer and immediately publish a new one.
		await stopCamera(b.page);
		await expect(remoteCameraIndicator(a.page)).toHaveCount(0, { timeout: 20_000 });
		await startCamera(b.page);
		await waitForStats(b.page, (s) => s.outboundVideoBytes > 0, 'B replacement camera to send');

		// A re-establishes watch on the replacement producer if a fresh indicator appears.
		await watchRemoteCamera(a.page).catch(() => {});

		// Measure a fresh delta so we prove live flow on the NEW producer.
		const baseline = await pcStats(a.page);
		await waitForStats(
			a.page,
			(s) => s.inboundVideoBytes > baseline.inboundVideoBytes,
			'A to consume B replacement producer',
			30_000,
		);

		// No stuck failure surfaced.
		await expect(a.page.getByText(/camera.*(failed|unavailable)/i)).toHaveCount(0);
	} finally {
		await leaveVoice(a.page).catch(() => {});
		await leaveVoice(b.page).catch(() => {});
		await a.context.close();
		await b.context.close();
	}
});
