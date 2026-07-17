import { expect, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	expectOutboundVideoFlow,
	joinVoice,
	pcStats,
	startCamera,
	waitForStats,
} from '../helpers/app';

test('local camera survives a short websocket drop', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');
		const beforeDrop = await pcStats(peer.page);

		await dropAppWebSocket(peer.page);
		await waitForStats(
			peer.page,
			(stats) => stats.peerConnections > beforeDrop.peerConnections,
			'new transports after the websocket reconnect',
		);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expectOutboundVideoFlow(peer.page, 'camera to resume after websocket reconnect');
		await expect(peer.page.getByText(/failed to reconnect|connection lost/i)).toHaveCount(0);
	} finally {
		await disposePeer(peer);
	}
});

test('voice teardown waits while the browser is offline and recovers when online', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');

		await peer.context.setOffline(true);
		await peer.page.waitForTimeout(8_000);
		await expect(peer.page.getByTitle('Leave voice')).toBeVisible();

		await peer.context.setOffline(false);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await expectOutboundVideoFlow(peer.page, 'camera to resume after browser connectivity returns', 40_000);
	} finally {
		await disposePeer(peer);
	}
});

test('voice returns to a coherent session after the reconnect grace expires', async ({ browser }, testInfo) => {
	test.setTimeout(150_000);
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');

		await peer.context.setOffline(true);
		await peer.page.waitForTimeout(65_000);
		await peer.context.setOffline(false);

		await expect(peer.page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 45_000 });
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
		await expect(peer.page.getByTitle('Leave voice')).toBeVisible();
		await expectOutboundVideoFlow(peer.page, 'camera to resume after the reconnect grace expires', 45_000);
		await expect(peer.page.getByText(/failed to reconnect|something went wrong/i)).toHaveCount(0);
	} finally {
		await disposePeer(peer);
	}
});
