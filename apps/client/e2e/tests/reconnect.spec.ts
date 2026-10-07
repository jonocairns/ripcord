import { expect, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	expectOutboundVideoFlow,
	installPcHook,
	joinVoice,
	login,
	pcStats,
	startCamera,
	suppressViteHmrReload,
	waitForStats,
} from '../helpers/app';
import { expectMicrophoneFlow, microphoneMediaStats } from '../helpers/microphone';
import { runVoiceRecoveryTest } from '../helpers/voice-recovery-test';
import { readVoiceServerEvents } from '../helpers/voice-server-events';
import { installAppWebSocketOutage } from '../helpers/websocket-outage';

test('local camera survives a short websocket drop', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');
		await expectMicrophoneFlow(peer.page, 'outbound');
		const beforeDrop = await pcStats(peer.page);

		await dropAppWebSocket(peer.page);
		await waitForStats(
			peer.page,
			(stats) => stats.peerConnections > beforeDrop.peerConnections,
			'new transports after the websocket reconnect',
		);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expectOutboundVideoFlow(peer.page, 'camera to resume after websocket reconnect');
		await expectMicrophoneFlow(peer.page, 'outbound');
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

test('voice returns to a coherent session after a long offline interval', async ({ browser }, testInfo) => {
	test.setTimeout(150_000);
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');
		await expectMicrophoneFlow(peer.page, 'outbound');

		await peer.context.setOffline(true);
		await peer.page.waitForTimeout(65_000);
		await peer.context.setOffline(false);

		await expect(peer.page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 45_000 });
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
		await expect(peer.page.getByTitle('Leave voice')).toBeVisible();
		await expectOutboundVideoFlow(peer.page, 'camera to resume after a long offline interval', 45_000);
		await expectMicrophoneFlow(peer.page, 'outbound');
		await expect(peer.page.getByText(/failed to reconnect|something went wrong/i)).toHaveCount(0);
	} finally {
		await disposePeer(peer);
	}
});

test('microphone and camera recover after confirmed server grace expiry', async ({ browser }, testInfo) => {
	test.setTimeout(200_000);
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	let disposeProducer: (() => Promise<void>) | undefined;
	let resumeOutage: (() => void) | undefined;

	await runVoiceRecoveryTest({
		run: async () => {
			const context = await browser.newContext();
			disposeProducer = () => context.close();
			await installPcHook(context);
			const page = await context.newPage();
			await suppressViteHmrReload(page);
			const outage = await installAppWebSocketOutage(page);
			resumeOutage = outage.resume;
			const credentials = credentialsFor(testInfo, 'producer');
			const producer = { context, page, credentials };
			disposeProducer = () => disposePeer(producer);

			await login(page, credentials);
			await joinVoice(watcher.page);
			await joinVoice(page);
			await startCamera(page);
			await expectOutboundVideoFlow(page, 'camera to send before grace expiry');
			const beforeMic = await expectMicrophoneFlow(page, 'outbound');
			const beforeReceivedMic = await expectMicrophoneFlow(watcher.page, 'inbound');
			const clientInstanceId = await page.evaluate(async () => {
				const modulePath = '/src/lib/trpc.ts';
				const module: unknown = await import(modulePath);
				if (typeof module !== 'object' || module === null) throw new Error('Could not load tRPC module');
				const getId: unknown = Reflect.get(module, 'getWsClientInstanceId');
				if (typeof getId !== 'function') throw new Error('Client instance getter is unavailable');
				const id: unknown = Reflect.apply(getId, module, []);
				if (typeof id !== 'string') throw new Error('Client instance ID is unavailable');
				return id;
			});

			// Offline recovery intentionally preserves the session beyond the normal
			// online reconnect deadline. Close the server socket explicitly so its
			// grace clock starts now rather than at a later TCP detection timeout.
			await context.setOffline(true);
			await outage.disconnect();
			await expect
				.poll(async () =>
					(await readVoiceServerEvents()).find(
						(event) => event.event === 'grace_scheduled' && event.clientInstanceId === clientInstanceId,
					),
				)
				.toMatchObject({ scope: 'voice_disconnect_grace', ttlRemainingMs: 60_000 });
			await expect
				.poll(
					async () =>
						(await readVoiceServerEvents()).find(
							(event) => event.event === 'grace_expired' && event.clientInstanceId === clientInstanceId,
						),
					{ timeout: 70_000 },
				)
				.toMatchObject({ scope: 'voice_disconnect_grace', graceAgeMs: expect.any(Number), ttlRemainingMs: 0 });
			const expired = (await readVoiceServerEvents()).find(
				(event) => event.event === 'grace_expired' && event.clientInstanceId === clientInstanceId,
			);
			if (!expired || expired.graceAgeMs === undefined) throw new Error('No confirmed grace expiry');
			// Allow small wall-clock reporting jitter without accepting seconds-early expiry.
			// Correlated expiry, fresh restore and recovered media remain required.
			const graceAgeToleranceMs = 100;
			expect(expired.graceAgeMs).toBeGreaterThanOrEqual(60_000 - graceAgeToleranceMs);
			await expect.poll(async () => (await microphoneMediaStats(watcher.page)).inbound.length).toBe(0);

			await context.setOffline(false);
			outage.resume();
			await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 50_000 });
			await expect
				.poll(async () =>
					(await readVoiceServerEvents()).find(
						(event) =>
							event.event === 'voice_session_attempt_finished' &&
							event.kind === 'restore' &&
							event.reconnectAttemptId !== undefined &&
							outage.getRestoreAttemptIds().includes(event.reconnectAttemptId) &&
							event.lineIndex > expired.lineIndex,
					),
				)
				.toMatchObject({ path: 'fresh', outcome: 'succeeded' });
			const afterMic = await expectMicrophoneFlow(page, 'outbound');
			const afterReceivedMic = await expectMicrophoneFlow(watcher.page, 'inbound');
			expect(afterMic.peerConnectionIndex).toBeGreaterThan(beforeMic.peerConnectionIndex);
			expect(afterMic.trackId).not.toBe(beforeMic.trackId);
			expect(afterReceivedMic.trackId).not.toBe(beforeReceivedMic.trackId);
			await expectOutboundVideoFlow(page, 'camera RTP to resume after confirmed server grace expiry', 45_000);
			await expect(page.getByTitle('Leave voice')).toBeVisible();
			await expect(page.getByText(/failed to reconnect|something went wrong/i)).toHaveCount(0);
			await testInfo.attach('microphone-identities', {
				body: JSON.stringify({ beforeMic, beforeReceivedMic, afterMic, afterReceivedMic }, null, 2),
				contentType: 'application/json',
			});
		},
		attachDiagnostics: async () => {
			await testInfo.attach('server-voice-events', {
				body: JSON.stringify(await readVoiceServerEvents(), null, 2),
				contentType: 'application/json',
			});
		},
		resumeOutage: () => resumeOutage?.(),
		disposePeers: [
			async () => {
				await disposeProducer?.();
			},
			() => disposePeer(watcher),
		],
	});
});
