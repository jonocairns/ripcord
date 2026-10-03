import { expect, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	expectInboundVideoFlow,
	expectOutboundVideoFlow,
	forceNewestConnectedPeerConnectionFailure,
	joinVoice,
	pcStats,
	remoteCameraIndicator,
	startCamera,
	waitForStats,
	watchRemoteCamera,
} from '../helpers/app';
import {
	expectCapture,
	expectScreenFlow,
	expectScreenStopped,
	holdProducerTransportCreation,
	installScreenCapture,
	sessionPhase,
	startScreenShare,
	watchScreenShare,
} from '../helpers/screen-share';

test('screen start, remote watch and explicit stop clean up screen media while a camera stays live', async ({
	browser,
}, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	try {
		await installScreenCapture(producer.page);
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startCamera(producer.page);
		await watchRemoteCamera(watcher.page);
		await expectInboundVideoFlow(watcher.page, 'camera traffic before the screen starts');

		await startScreenShare(producer.page);
		await expectCapture(producer.page, 'live');
		await watchScreenShare(watcher.page);
		expect((await pcStats(producer.page)).liveOutboundVideoTracks).toBe(2);

		await producer.page.getByTitle('Stop sharing', { exact: true }).click();
		await expectScreenStopped(producer.page, watcher.page);
		await expect(producer.page.getByTitle('Share screen', { exact: true })).toBeVisible();
		await expect(remoteCameraIndicator(watcher.page)).toHaveCount(1);
		await expectOutboundVideoFlow(producer.page, 'camera RTP remains after stopping the screen');
		await expectInboundVideoFlow(watcher.page, 'camera RTP remains after stopping the screen');
		expect((await pcStats(producer.page)).liveOutboundVideoTracks).toBe(1);
	} finally {
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('producer reconnect preserves the captured screen and republishes it to the watcher', async ({
	browser,
}, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	try {
		await installScreenCapture(producer.page);
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startScreenShare(producer.page);
		const originalSender = await expectScreenFlow(producer.page, 'outbound');
		const originalReceiver = await watchScreenShare(watcher.page);
		const beforeDrop = await pcStats(producer.page);

		await dropAppWebSocket(producer.page);
		await waitForStats(
			producer.page,
			(stats) => stats.peerConnections > beforeDrop.peerConnections,
			'producer replacement transports',
		);
		await expect.poll(() => sessionPhase(producer.page), { timeout: 40_000 }).toBe('connected');
		const replacementSender = await expectScreenFlow(producer.page, 'outbound');
		expect(replacementSender.peerConnectionIndex).toBeGreaterThan(originalSender.peerConnectionIndex);
		expect(replacementSender.trackId).toBe(originalSender.trackId);
		await expectCapture(producer.page, 'live', originalSender.trackId);
		const replacementReceiver = await expectScreenFlow(watcher.page, 'inbound');
		expect(replacementReceiver.trackId).not.toBe(originalReceiver.trackId);

		await producer.page.getByTitle('Stop sharing', { exact: true }).click();
		await expectScreenStopped(producer.page, watcher.page);
	} finally {
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('watcher reconnect retains screen watch intent and restores decoded screen media', async ({
	browser,
}, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	try {
		await installScreenCapture(producer.page);
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startScreenShare(producer.page);
		const originalReceiver = await watchScreenShare(watcher.page);
		const beforeDrop = await pcStats(watcher.page);

		await dropAppWebSocket(watcher.page);
		await waitForStats(
			watcher.page,
			(stats) => stats.peerConnections > beforeDrop.peerConnections,
			'watcher replacement transports',
		);
		await expect.poll(() => sessionPhase(watcher.page), { timeout: 40_000 }).toBe('connected');
		// No second watch click: restored media must come from retained intent.
		const replacementReceiver = await expectScreenFlow(watcher.page, 'inbound');
		expect(replacementReceiver.peerConnectionIndex).toBeGreaterThan(originalReceiver.peerConnectionIndex);
		expect(replacementReceiver.trackId).not.toBe(originalReceiver.trackId);
		await expectCapture(producer.page, 'live');

		await producer.page.getByTitle('Stop sharing', { exact: true }).click();
		await expectScreenStopped(producer.page, watcher.page);
	} finally {
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('stopping during a held transport rebuild does not resurrect the screen share', async ({ browser }, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	try {
		await installScreenCapture(producer.page);
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startScreenShare(producer.page);
		await watchScreenShare(watcher.page);
		const beforeRecovery = await pcStats(producer.page);
		await holdProducerTransportCreation(producer.page);
		await forceNewestConnectedPeerConnectionFailure(producer.page);
		await producer.page.waitForFunction(() => window.__ripcordE2eTransportGate?.held === 1);
		expect(await sessionPhase(producer.page)).toBe('rebuilding');
		await expectCapture(producer.page, 'live');

		await producer.page.getByTitle('Stop sharing', { exact: true }).click();
		await expectCapture(producer.page, 'ended');
		expect((await pcStats(producer.page)).liveOutboundVideoTracks).toBe(0);
		// The server retires its old producer/consumer when replacement transport
		// creation proceeds; require remote cleanup after releasing that boundary.
		await producer.page.evaluate(() => window.__ripcordE2eTransportGate?.release());
		await waitForStats(
			producer.page,
			(stats) => stats.peerConnections > beforeRecovery.peerConnections,
			'transport rebuild after releasing the gate',
		);
		await expect.poll(() => sessionPhase(producer.page), { timeout: 40_000 }).toBe('connected');
		await expect(producer.page.getByTitle('Share screen', { exact: true })).toBeVisible();
		await expectScreenStopped(producer.page, watcher.page);
		expect((await pcStats(producer.page)).liveOutboundVideoTracks).toBe(0);
	} finally {
		await producer.page.evaluate(() => window.__ripcordE2eTransportGate?.release()).catch(() => {});
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});
