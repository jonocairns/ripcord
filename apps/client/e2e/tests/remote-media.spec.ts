import { expect, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	expectInboundVideoFlow,
	expectInboundVideoIdle,
	expectOutboundVideoFlow,
	joinVoice,
	pcStats,
	remoteCameraIndicator,
	startCamera,
	stopCamera,
	waitForStats,
	watchRemoteCamera,
} from '../helpers/app';

test('a remote camera watch survives reconnect and clears when the producer stops', async ({ browser }, testInfo) => {
	test.setTimeout(150_000);
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));

	try {
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startCamera(producer.page);
		await expectOutboundVideoFlow(producer.page, 'remote camera to start sending');
		await watchRemoteCamera(watcher.page);
		await expectInboundVideoFlow(watcher.page, 'watcher to receive the remote camera');
		const beforeDrop = await pcStats(watcher.page);

		await dropAppWebSocket(watcher.page);
		await waitForStats(
			watcher.page,
			(stats) => stats.peerConnections > beforeDrop.peerConnections,
			'watcher transports to be rebuilt',
			40_000,
		);
		await expectInboundVideoFlow(watcher.page, 'remote camera watch intent to resume after reconnect', 40_000);

		await stopCamera(producer.page);
		await expect(remoteCameraIndicator(watcher.page)).toHaveCount(0, { timeout: 20_000 });
		await expectInboundVideoIdle(watcher.page, 'remote camera RTP to stop after the producer stops');
		await expect(watcher.page.getByText(/camera.*(failed|unavailable)/i)).toHaveCount(0);
	} finally {
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('a watcher consumes a replacement camera without retaining the stopped stream', async ({ browser }, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));

	try {
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startCamera(producer.page);
		await expectOutboundVideoFlow(producer.page, 'first camera producer to send');
		await watchRemoteCamera(watcher.page);
		await expectInboundVideoFlow(watcher.page, 'watcher to receive the first camera producer');

		await stopCamera(producer.page);
		await expectInboundVideoIdle(watcher.page, 'first remote camera RTP stream to stop');

		await startCamera(producer.page);
		await expectOutboundVideoFlow(producer.page, 'replacement camera producer to send');
		await watchRemoteCamera(watcher.page);
		await expectInboundVideoFlow(watcher.page, 'watcher to receive the replacement camera producer');
		await expect(watcher.page.getByText(/camera.*(failed|unavailable)/i)).toHaveCount(0);
	} finally {
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('a watcher resumes a camera after the producer reconnects', async ({ browser }, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));

	try {
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startCamera(producer.page);
		await expectOutboundVideoFlow(producer.page, 'producer camera to start sending');
		await watchRemoteCamera(watcher.page);
		await expectInboundVideoFlow(watcher.page, 'watcher to receive the producer camera');
		const producerStatsBeforeDrop = await pcStats(producer.page);

		await dropAppWebSocket(producer.page);
		await waitForStats(
			producer.page,
			(stats) => stats.peerConnections > producerStatsBeforeDrop.peerConnections,
			'producer transports to be rebuilt',
			40_000,
		);
		await expectOutboundVideoFlow(producer.page, 'producer camera to resume after reconnect', 40_000);
		await expectInboundVideoFlow(watcher.page, 'watcher to resume the producer camera', 40_000);
	} finally {
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('a remote participant leaving while live removes the camera and stops its media', async ({
	browser,
}, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));

	try {
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startCamera(producer.page);
		await expectOutboundVideoFlow(producer.page, 'remote camera to start sending');
		await watchRemoteCamera(watcher.page);
		await expectInboundVideoFlow(watcher.page, 'watcher to receive the remote camera');

		await disposePeer(producer);
		await expect(remoteCameraIndicator(watcher.page)).toHaveCount(0, { timeout: 20_000 });
		await expectInboundVideoIdle(watcher.page, 'remote camera RTP to stop after its participant leaves');
		await expect(watcher.page.getByText(/camera.*(failed|unavailable)/i)).toHaveCount(0);
	} finally {
		await disposePeer(watcher);
		if (producer.context.pages().length > 0) {
			await disposePeer(producer);
		}
	}
});
