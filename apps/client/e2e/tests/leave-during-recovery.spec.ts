import { expect, type Page, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	joinVoice,
	pcStats,
	startCamera,
} from '../helpers/app';
import { readVoiceServerEvents } from '../helpers/voice-server-events';

const voiceMembership = (page: Page) =>
	page.evaluate(async () => {
		const modulePath = '/src/features/server/slice.ts';
		const module: unknown = await import(modulePath);
		if (typeof module !== 'object' || module === null) throw new Error('Server store module unavailable');
		const store: unknown = Reflect.get(module, 'useServerStore');
		if (typeof store !== 'function') throw new Error('Server store unavailable');
		const getState: unknown = Reflect.get(store, 'getState');
		if (typeof getState !== 'function') throw new Error('Server state unavailable');
		const state: unknown = getState();
		if (typeof state !== 'object' || state === null) throw new Error('Invalid server state');
		const ownUserId: unknown = Reflect.get(state, 'ownUserId');
		const voiceMap: unknown = Reflect.get(state, 'voiceMap');
		if (typeof ownUserId !== 'number' || typeof voiceMap !== 'object' || voiceMap === null) {
			throw new Error('Voice membership unavailable');
		}
		const memberIds = Object.values(voiceMap).flatMap((channel: unknown) => {
			if (typeof channel !== 'object' || channel === null) return [];
			const users: unknown = Reflect.get(channel, 'users');
			return typeof users === 'object' && users !== null ? Object.keys(users).map(Number) : [];
		});
		return { ownUserId, memberIds };
	});

test('leaving when the socket drops during a delayed restore removes the server seat and stays in the app', async ({
	browser,
}, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	let holdHandshake = false;
	const heldHandshakes: (() => void)[] = [];
	await producer.page.routeWebSocket(
		(url) => url.port === '4991',
		(socket) => {
			const server = socket.connectToServer();
			socket.onMessage((message) => {
				// Hold re-authentication on the second replacement socket so the
				// leave deterministically happens before joinServer can complete.
				if (holdHandshake && typeof message === 'string' && message.includes('"others.handshake"')) {
					heldHandshakes.push(() => server.send(message));
				} else {
					server.send(message);
				}
			});
		},
	);
	try {
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await startCamera(producer.page);
		const { ownUserId } = await voiceMembership(producer.page);
		await expect.poll(async () => (await voiceMembership(watcher.page)).memberIds).toContain(ownUserId);

		const previousAttempts = (await readVoiceServerEvents()).filter((event) => event.event === 'attempt').length;
		await producer.page.getByRole('button', { name: 'Open reconnect lab' }).click();
		await producer.page.getByRole('button', { name: 'Slow restore + drop WS', exact: true }).click();
		await expect
			.poll(async () => (await readVoiceServerEvents()).filter((event) => event.event === 'attempt').length)
			.toBeGreaterThan(previousAttempts);
		holdHandshake = true;
		await dropAppWebSocket(producer.page, { waitForReconnect: false });
		await expect.poll(() => heldHandshakes.length).toBeGreaterThan(0);
		await producer.page.getByTitle('Leave voice', { exact: true }).click();
		await expect(producer.page.getByTitle('Leave voice', { exact: true })).toHaveCount(0);
		await expect.poll(async () => (await pcStats(producer.page)).liveOutboundVideoTracks).toBe(0);
		holdHandshake = false;
		for (const release of heldHandshakes.splice(0)) release();
		await expect.poll(async () => (await voiceMembership(watcher.page)).memberIds).not.toContain(ownUserId);

		// Let the five-second server restore settle before checking that it cannot
		// recreate membership after the explicit leave.
		await producer.page.waitForTimeout(6_000);
		await expect(producer.page.getByText('VOICE CHANNELS')).toBeVisible();
		expect((await voiceMembership(watcher.page)).memberIds).not.toContain(ownUserId);
		await joinVoice(producer.page);
		await expect.poll(async () => (await voiceMembership(watcher.page)).memberIds).toContain(ownUserId);
	} finally {
		holdHandshake = false;
		for (const release of heldHandshakes.splice(0)) release();
		await disposePeer(producer);
		await disposePeer(watcher);
	}
});
