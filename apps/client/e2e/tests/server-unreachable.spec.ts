import { expect, test, type WebSocketRoute } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	installPcHook,
	joinVoice,
	login,
	suppressViteHmrReload,
} from '../helpers/app';
import { expectMicrophoneFlow } from '../helpers/microphone';
import { installServerUnreachableFault } from '../helpers/server-unreachable';
import { runVoiceRecoveryTest } from '../helpers/voice-recovery-test';

for (const muted of [false, true]) {
	test(`voice restores after an online server outage reaches the disconnect screen (muted: ${muted})`, async ({
		browser,
	}, testInfo) => {
		test.setTimeout(150_000);
		const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
		let disposeProducer: (() => Promise<void>) | undefined;
		let restoreOutage: (() => void) | undefined;

		await runVoiceRecoveryTest({
			run: async () => {
				const context = await browser.newContext();
				disposeProducer = () => context.close();
				await installPcHook(context);
				const page = await context.newPage();
				await suppressViteHmrReload(page);
				const fault = await installServerUnreachableFault(page);
				restoreOutage = fault.restore;
				const credentials = credentialsFor(testInfo, 'producer');
				disposeProducer = () => disposePeer({ context, page, credentials });
				await login(page, credentials);

				await joinVoice(watcher.page);
				await joinVoice(page);
				await expectMicrophoneFlow(page, 'outbound');
				await expectMicrophoneFlow(watcher.page, 'inbound');

				if (muted) {
					await page.getByTitle('Mute microphone').click();
					await expect(page.getByTitle('Unmute microphone')).toBeVisible();
				}
				// cut() detects a close explicitly; this does not measure half-open detection.
				const droppedAt = Date.now();
				await fault.cut();
				await expect(page.getByText('Connection lost', { exact: true })).toBeVisible({ timeout: 60_000 });
				const elapsed = Date.now() - droppedAt;
				expect(elapsed).toBeGreaterThan(40_000);
				expect(elapsed).toBeLessThan(55_000);
				expect(await page.evaluate(() => navigator.onLine)).toBe(true);
				fault.restore();

				await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 30_000 });
				await expect(page.getByTitle('Leave voice')).toBeVisible({ timeout: 30_000 });
				if (muted) {
					await expect(page.getByTitle('Unmute microphone')).toBeVisible();
					await page.getByTitle('Unmute microphone').click();
				}
				await expectMicrophoneFlow(page, 'outbound');
				await expectMicrophoneFlow(watcher.page, 'inbound');
				await expect(page.getByText(/reconnect failed|failed to reconnect|something went wrong/i)).toHaveCount(0);
			},
			attachDiagnostics: async () => {},
			resumeOutage: () => restoreOutage?.(),
			disposePeers: [async () => disposeProducer?.(), () => disposePeer(watcher)],
		});
	});
}

test('failed silent rejoin shows the disconnect screen and retries with saved credentials', async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	const page = await context.newPage();
	const credentials = credentialsFor(testInfo);
	const peer = { context, page, credentials };
	let rejectRejoin = false;
	let rejectedHandshakes = 0;
	try {
		await suppressViteHmrReload(page);
		await page.routeWebSocket(
			(url) => url.port === '4991',
			(socket) => {
				const server = socket.connectToServer();
				socket.onMessage((message) => {
					if (rejectRejoin && typeof message === 'string' && message !== 'PING' && message !== 'PONG') {
						const payload: unknown = JSON.parse(message);
						const requests: unknown[] = Array.isArray(payload) ? payload : [payload];
						for (const request of requests) {
							if (typeof request !== 'object' || request === null) continue;
							const params: unknown = Reflect.get(request, 'params');
							if (typeof params !== 'object' || params === null || Reflect.get(params, 'path') !== 'others.handshake') {
								server.send(JSON.stringify(request));
								continue;
							}
							rejectedHandshakes += 1;
							socket.send(
								JSON.stringify({
									id: Reflect.get(request, 'id'),
									error: {
										message: 'Injected rejoin failure',
										code: -32603,
										data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
									},
								}),
							);
						}
						return;
					}
					server.send(message);
				});
			},
		);
		await login(page, credentials);
		await joinVoice(page);
		await expectMicrophoneFlow(page, 'outbound');
		rejectRejoin = true;
		await dropAppWebSocket(page, { waitForReconnect: false });
		await expect(page.getByRole('heading', { name: 'Connection lost', exact: true })).toBeVisible();
		expect(rejectedHandshakes).toBeGreaterThan(0);
		await expect(page.getByText('Trying to reconnect every 5 seconds.')).toBeVisible();
		rejectRejoin = false;
		await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 30_000 });
		// The disconnect screen is a recovery path: the retry restores voice too.
		await expect(page.getByTitle('Leave voice')).toBeVisible({ timeout: 30_000 });
		await expectMicrophoneFlow(page, 'outbound');
	} finally {
		await disposePeer(peer);
	}
});

test('a rejoin that never answers ends on the disconnect screen', async ({ browser }, testInfo) => {
	test.setTimeout(120_000);
	const context = await browser.newContext();
	await installPcHook(context);
	const page = await context.newPage();
	const credentials = credentialsFor(testInfo);
	let holdHandshakes = false;
	let heldHandshakes = 0;
	const pendingHandshakes: { server: WebSocketRoute; request: string }[] = [];
	try {
		await suppressViteHmrReload(page);
		await page.routeWebSocket(
			(url) => url.port === '4991',
			(socket) => {
				const server = socket.connectToServer();
				socket.onMessage((message) => {
					if (typeof message !== 'string' || message === 'PING' || message === 'PONG') {
						server.send(message);
						return;
					}
					const payload: unknown = JSON.parse(message);
					const requests: unknown[] = Array.isArray(payload) ? payload : [payload];
					for (const request of requests) {
						if (holdHandshakes && typeof request === 'object' && request !== null) {
							const params: unknown = Reflect.get(request, 'params');
							if (typeof params === 'object' && params !== null && Reflect.get(params, 'path') === 'others.handshake') {
								heldHandshakes += 1;
								pendingHandshakes.push({ server, request: JSON.stringify(request) });
								continue;
							}
						}
						server.send(JSON.stringify(request));
					}
				});
			},
		);
		await login(page, credentials);
		await joinVoice(page);
		await expectMicrophoneFlow(page, 'outbound');
		holdHandshakes = true;
		await dropAppWebSocket(page, { waitForReconnect: false });
		await expect(page.getByRole('heading', { name: 'Connection lost', exact: true })).toBeVisible({ timeout: 60_000 });
		expect(heldHandshakes).toBeGreaterThan(0);
		holdHandshakes = false;
		// Release both the stalled rejoin and any immediate disconnect-screen retry.
		for (const { server, request } of pendingHandshakes.splice(0)) server.send(request);
		await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 30_000 });
	} finally {
		await disposePeer({ context, page, credentials });
	}
});
