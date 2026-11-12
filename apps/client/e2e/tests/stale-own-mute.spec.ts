import { expect, test } from '@playwright/test';
import { createPeer, credentialsFor, disposePeer, joinVoice, type pcStats } from '../helpers/app';

const getRemoteMicMuted = async (page: Parameters<typeof pcStats>[0], userId: number): Promise<boolean | undefined> => {
	return page.evaluate(async (userId) => {
		const modulePath = '/src/features/server/slice.ts';
		const serverModule: unknown = await import(modulePath);
		if (typeof serverModule !== 'object' || serverModule === null) {
			throw new Error('Could not load the server store module');
		}

		const serverStore = Reflect.get(serverModule, 'useServerStore');
		const getState =
			serverStore !== null && (typeof serverStore === 'object' || typeof serverStore === 'function')
				? Reflect.get(serverStore, 'getState')
				: undefined;
		if (typeof getState !== 'function') {
			throw new Error('The server store does not expose getState');
		}

		const state: unknown = Reflect.apply(getState, serverStore, []);
		if (typeof state !== 'object' || state === null) {
			throw new Error('The server store returned an invalid state');
		}

		const ownUserId = Reflect.get(state, 'ownUserId');
		const currentVoiceChannelId = Reflect.get(state, 'currentVoiceChannelId');
		const voiceMap = Reflect.get(state, 'voiceMap');
		if (
			typeof ownUserId !== 'number' ||
			typeof currentVoiceChannelId !== 'number' ||
			typeof voiceMap !== 'object' ||
			voiceMap === null
		) {
			return undefined;
		}

		const channel = Reflect.get(voiceMap, currentVoiceChannelId);
		const users = typeof channel === 'object' && channel !== null ? Reflect.get(channel, 'users') : undefined;
		if (typeof users !== 'object' || users === null) {
			return undefined;
		}

		const remoteVoiceState: unknown = Reflect.get(users, userId);
		if (typeof remoteVoiceState !== 'object' || remoteVoiceState === null) {
			return undefined;
		}

		const micMuted = Reflect.get(remoteVoiceState, 'micMuted');
		return typeof micMuted === 'boolean' ? micMuted : undefined;
	}, userId);
};

test('a stale own unmuted server echo cannot undo a local mute after five seconds', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));
	const observer = await createPeer(browser, credentialsFor(testInfo, 'observer'));
	let replay: (() => void) | undefined;
	let subscriptionId: unknown;
	await peer.page.routeWebSocket(
		(url) => url.port === '4991',
		(socket) => {
			const server = socket.connectToServer();

			socket.onMessage((message) => {
				if (typeof message === 'string' && message !== 'PING' && message !== 'PONG') {
					const payload: unknown = JSON.parse(message);
					for (const frame of Array.isArray(payload) ? payload : [payload]) {
						if (typeof frame !== 'object' || frame === null) continue;
						const params: unknown = Reflect.get(frame, 'params');
						if (typeof params === 'object' && params !== null && Reflect.get(params, 'path') === 'voice.onUpdateState')
							subscriptionId = Reflect.get(frame, 'id');
					}
				}
				server.send(message);
			});
			server.onMessage((message) => {
				if (typeof message === 'string' && message !== 'PING' && message !== 'PONG') {
					const payload: unknown = JSON.parse(message);
					for (const frame of Array.isArray(payload) ? payload : [payload]) {
						if (
							typeof frame !== 'object' ||
							frame === null ||
							subscriptionId === undefined ||
							Reflect.get(frame, 'id') !== subscriptionId
						)
							continue;
						if (JSON.stringify(frame).includes('"micMuted":false')) replay = () => socket.send(JSON.stringify(frame));
					}
				}
				socket.send(message);
			});
		},
	);
	try {
		// Reconnect so the route owns the app socket opened before routing.
		await peer.page.reload();
		await joinVoice(peer.page);
		const ownUserId = await peer.page.evaluate(async () => {
			const path = '/src/features/server/slice.ts';
			const module = await import(path);
			const id: unknown = module.useServerStore.getState().ownUserId;
			if (typeof id !== 'number') throw Error('Missing own user id');
			return id;
		});
		await peer.page.getByTitle('Mute microphone', { exact: true }).click();
		await peer.page.getByTitle('Unmute microphone', { exact: true }).click();
		await expect.poll(() => !!replay).toBe(true);
		const replayOwnUnmuted = replay;
		if (!replayOwnUnmuted) throw Error('No own unmuted frame captured');
		await peer.page.getByTitle('Mute microphone', { exact: true }).click();
		await joinVoice(observer.page);
		await expect.poll(() => getRemoteMicMuted(observer.page, ownUserId)).toBe(true);
		// Main's optimistic self-state guard lasts five seconds.
		await peer.page.waitForTimeout(5500);
		replayOwnUnmuted();
		await peer.page.waitForTimeout(500);
		await expect(peer.page.getByTitle('Unmute microphone', { exact: true })).toBeVisible();
		await expect.poll(() => getRemoteMicMuted(observer.page, ownUserId)).toBe(true);
	} finally {
		await disposePeer(observer);
		await disposePeer(peer);
	}
});
