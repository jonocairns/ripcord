import { expect, test } from '@playwright/test';
import {
	clearServerVoiceSession,
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	expectLocalVideoStopped,
	expectOutboundVideoFlow,
	installPcHook,
	joinVoice,
	login,
	moderatePeer,
	pcStats,
	startCamera,
	stopCamera,
	suppressViteHmrReload,
	waitForStats,
} from '../helpers/app';

declare global {
	interface Window {
		__ripcordE2eFailMicAcquisition?: boolean;
		__ripcordE2eFailNextVoiceStateUpdate?: boolean;
		__ripcordE2eNowOffsetMs?: number;
		__ripcordE2eRawAudioTracks?: MediaStreamTrack[];
	}
}

const forceNewestConnectedPeerConnectionFailure = async (page: Parameters<typeof pcStats>[0]): Promise<void> => {
	await page.evaluate(() => {
		const peerConnection = window.__ripcordE2ePeerConnections?.findLast(
			(candidate) => candidate.connectionState === 'connected',
		);
		if (!peerConnection) {
			throw new Error('No connected peer connection was available to fail');
		}

		Object.defineProperty(peerConnection, 'connectionState', {
			configurable: true,
			get: () => 'failed',
		});
		peerConnection.dispatchEvent(new Event('connectionstatechange'));
	});
};

const getOnlyRemoteMicMuted = async (page: Parameters<typeof pcStats>[0]): Promise<boolean | undefined> => {
	return page.evaluate(async () => {
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

		const remoteVoiceStates = Object.entries(users).filter(([userId]) => Number(userId) !== ownUserId);
		if (remoteVoiceStates.length !== 1) {
			return undefined;
		}

		const remoteVoiceState = remoteVoiceStates[0]?.[1];
		if (typeof remoteVoiceState !== 'object' || remoteVoiceState === null) {
			return undefined;
		}

		const micMuted = Reflect.get(remoteVoiceState, 'micMuted');
		return typeof micMuted === 'boolean' ? micMuted : undefined;
	});
};

test('deafened audio state survives a websocket reconnect', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await peer.page.getByTitle('Deafen').click();
		await expect(peer.page.getByTitle('Undeafen')).toBeVisible();

		await dropAppWebSocket(peer.page);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(peer.page.getByTitle('Undeafen')).toBeVisible();
	} finally {
		await disposePeer(peer);
	}
});

test('rapid websocket flaps converge on the latest session', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');
		const beforeFault = await pcStats(peer.page);

		for (let attempt = 0; attempt < 4; attempt += 1) {
			await dropAppWebSocket(peer.page);
		}

		await waitForStats(
			peer.page,
			(stats) => stats.peerConnections > beforeFault.peerConnections,
			'websocket recovery to create replacement peer connections',
			45_000,
		);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(peer.page.getByTitle('Leave voice')).toBeVisible();
		await expectOutboundVideoFlow(peer.page, 'camera to send after repeated websocket recovery', 40_000);
	} finally {
		await disposePeer(peer);
	}
});

test('muted microphone state survives a websocket reconnect', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await peer.page.getByTitle('Mute microphone').click();
		await expect(peer.page.getByTitle('Unmute microphone')).toBeVisible();

		await dropAppWebSocket(peer.page);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(peer.page.getByTitle('Unmute microphone')).toBeVisible();
	} finally {
		await disposePeer(peer);
	}
});

test('repeated default-device changes do not republish a muted microphone', async ({ browser }, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	await context.addInitScript(() => {
		const nativeGetSettings = MediaStreamTrack.prototype.getSettings;
		MediaStreamTrack.prototype.getSettings = function () {
			const settings = nativeGetSettings.call(this);
			return this.kind === 'audio' ? { ...settings, groupId: 'captured-device-group' } : settings;
		};

		const nativeEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
		navigator.mediaDevices.enumerateDevices = async () => {
			const devices = await nativeEnumerateDevices();
			return devices.map((device) => {
				if (device.kind !== 'audioinput' || device.deviceId !== 'default') {
					return device;
				}

				return {
					deviceId: device.deviceId,
					groupId: 'system-default-device-group',
					kind: device.kind,
					label: device.label,
					toJSON: () => device.toJSON(),
				};
			});
		};
	});

	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const credentials = credentialsFor(testInfo);
	await login(page, credentials);
	const peer = { context, page, credentials };
	const micLifecycleEvents: string[] = [];
	page.on('console', (message) => {
		const text = message.text();
		if (text.includes('Microphone audio producer created') || text.includes('Audio producer closed')) {
			micLifecycleEvents.push(text);
		}
	});

	try {
		await joinVoice(page);
		await expect
			.poll(() => micLifecycleEvents.filter((event) => event.includes('Microphone audio producer created')).length)
			.toBeGreaterThanOrEqual(1);

		await page.getByTitle('Mute microphone').click();
		await expect(page.getByTitle('Unmute microphone')).toBeVisible();
		const producerCountBeforeDeviceChanges = micLifecycleEvents.filter((event) =>
			event.includes('Microphone audio producer created'),
		).length;
		const closeCountBeforeDeviceChanges = micLifecycleEvents.filter((event) =>
			event.includes('Audio producer closed'),
		).length;

		await page.evaluate(async () => {
			for (let eventIndex = 0; eventIndex < 6; eventIndex += 1) {
				navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
				await new Promise((resolve) => setTimeout(resolve, 750));
			}
		});

		await expect
			.poll(() => micLifecycleEvents.filter((event) => event.includes('Audio producer closed')).length)
			.toBe(closeCountBeforeDeviceChanges + 1);
		await page.waitForTimeout(2_000);
		expect(micLifecycleEvents.filter((event) => event.includes('Microphone audio producer created'))).toHaveLength(
			producerCountBeforeDeviceChanges,
		);
		await expect(page.getByTitle('Unmute microphone')).toBeVisible();

		await page.getByTitle('Unmute microphone').click();
		await expect(page.getByTitle('Mute microphone')).toBeVisible();
		await expect
			.poll(() => micLifecycleEvents.filter((event) => event.includes('Microphone audio producer created')).length)
			.toBe(producerCountBeforeDeviceChanges + 1);
	} finally {
		await disposePeer(peer);
	}
});

test('repeated raw microphone loss stops after bounded recovery attempts', async ({ browser }, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	await context.addInitScript(() => {
		const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (constraints) => {
			const stream = await nativeGetUserMedia(constraints);
			if (constraints?.audio) {
				for (const track of stream.getAudioTracks()) {
					setTimeout(() => track.dispatchEvent(new Event('ended')), 600);
				}
			}
			return stream;
		};
	});

	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const credentials = credentialsFor(testInfo);
	await login(page, credentials);
	const peer = { context, page, credentials };
	const micLifecycleEvents: string[] = [];
	page.on('console', (message) => {
		const text = message.text();
		if (
			text.includes('Microphone audio producer created') ||
			text.includes('Audio producer closed') ||
			text.includes('Raw microphone recovery exhausted')
		) {
			micLifecycleEvents.push(text);
		}
	});

	try {
		await joinVoice(page);
		await expect(page.getByTitle('Unmute microphone')).toBeVisible({ timeout: 15_000 });
		await expect
			.poll(() => micLifecycleEvents.filter((event) => event.includes('Raw microphone recovery exhausted')).length)
			.toBe(1);

		const producerCountAtExhaustion = micLifecycleEvents.filter((event) =>
			event.includes('Microphone audio producer created'),
		).length;
		const closeCountAtExhaustion = micLifecycleEvents.filter((event) => event.includes('Audio producer closed')).length;
		expect(producerCountAtExhaustion).toBe(4);
		expect(closeCountAtExhaustion).toBe(4);

		await page.waitForTimeout(2_000);
		expect(micLifecycleEvents.filter((event) => event.includes('Microphone audio producer created'))).toHaveLength(
			producerCountAtExhaustion,
		);
		expect(micLifecycleEvents.filter((event) => event.includes('Audio producer closed'))).toHaveLength(
			closeCountAtExhaustion,
		);
	} finally {
		await disposePeer(peer);
	}
});

test('failed raw microphone reacquisition exhausts once and a later unmute retries capture', async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	await context.addInitScript(() => {
		window.__ripcordE2eRawAudioTracks = [];
		const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (constraints) => {
			if (constraints?.audio && window.__ripcordE2eFailMicAcquisition) {
				throw new DOMException('Injected microphone acquisition failure', 'NotReadableError');
			}

			const stream = await nativeGetUserMedia(constraints);
			if (constraints?.audio) {
				window.__ripcordE2eRawAudioTracks?.push(...stream.getAudioTracks());
			}
			return stream;
		};
	});

	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const credentials = credentialsFor(testInfo);
	await login(page, credentials);
	const peer = { context, page, credentials };
	const recoveryEvents: string[] = [];
	page.on('console', (message) => {
		if (message.text().includes('Raw microphone recovery exhausted')) {
			recoveryEvents.push(message.text());
		}
	});

	try {
		await joinVoice(page);
		await page.waitForFunction(() => (window.__ripcordE2eRawAudioTracks?.length ?? 0) === 1);
		await page.evaluate(() => {
			window.__ripcordE2eFailMicAcquisition = true;
			window.__ripcordE2eRawAudioTracks?.at(-1)?.dispatchEvent(new Event('ended'));
		});

		await expect(page.getByTitle('Unmute microphone')).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => recoveryEvents.length).toBe(1);
		expect(await page.evaluate(() => window.__ripcordE2eRawAudioTracks?.length ?? 0)).toBe(1);

		await page.evaluate(() => {
			window.__ripcordE2eFailMicAcquisition = false;
		});
		await page.getByTitle('Unmute microphone').click();
		await expect(page.getByTitle('Mute microphone')).toBeVisible();
		await page.waitForFunction(() => (window.__ripcordE2eRawAudioTracks?.length ?? 0) === 2);
	} finally {
		await disposePeer(peer);
	}
});

test('transport recovery continues listen-only when microphone restart fails', async ({ browser }, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	await context.addInitScript(() => {
		const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (constraints) => {
			if (constraints?.audio && window.__ripcordE2eFailMicAcquisition) {
				throw new DOMException('Injected transport recovery microphone failure', 'NotReadableError');
			}

			return nativeGetUserMedia(constraints);
		};
	});

	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const credentials = credentialsFor(testInfo);
	await login(page, credentials);
	const peer = { context, page, credentials };
	const recoveryEvents: string[] = [];
	page.on('console', (message) => {
		if (
			message.text().includes('Microphone restart failed during transport recovery; continuing muted') ||
			message.text().includes('Voice transport recovery completed successfully')
		) {
			recoveryEvents.push(message.text());
		}
	});

	try {
		await joinVoice(page);
		await page.evaluate(() => {
			window.__ripcordE2eFailMicAcquisition = true;
			const peerConnection = window.__ripcordE2ePeerConnections?.findLast(
				(candidate) => candidate.connectionState === 'connected',
			);
			const microphoneSender = peerConnection?.getSenders().find((sender) => sender.track?.kind === 'audio');
			if (!microphoneSender?.track) {
				throw new Error('No live microphone sender was available to stop');
			}
			microphoneSender.track.stop();
		});

		await forceNewestConnectedPeerConnectionFailure(page);

		await expect
			.poll(
				() =>
					recoveryEvents.filter((event) =>
						event.includes('Microphone restart failed during transport recovery; continuing muted'),
					).length,
				{ timeout: 20_000 },
			)
			.toBe(1);
		await expect
			.poll(
				() =>
					recoveryEvents.filter((event) => event.includes('Voice transport recovery completed successfully')).length,
				{ timeout: 20_000 },
			)
			.toBe(1);
		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(page.getByTitle('Leave voice')).toBeVisible();
		await expect(page.getByTitle('Unmute microphone')).toBeVisible();
	} finally {
		await disposePeer(peer);
	}
});

test('a failed user microphone mutation rolls back while reconnect converges on that rollback', async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	await context.addInitScript(() => {
		const nativeSend = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			if (
				window.__ripcordE2eFailNextVoiceStateUpdate &&
				typeof data === 'string' &&
				data.includes('voice.updateState')
			) {
				window.__ripcordE2eFailNextVoiceStateUpdate = false;
				this.close(4013, 'Injected user microphone state failure');
				return;
			}

			nativeSend.call(this, data);
		};
	});

	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const credentials = credentialsFor(testInfo);
	await login(page, credentials);
	const peer = { context, page, credentials };

	try {
		await joinVoice(page);
		await page.evaluate(() => {
			window.__ripcordE2eFailNextVoiceStateUpdate = true;
		});
		await page.getByTitle('Mute microphone').click();

		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTitle('Mute microphone')).toBeVisible();
		expect(await page.evaluate(() => window.__ripcordE2eFailNextVoiceStateUpdate)).toBe(false);
	} finally {
		await disposePeer(peer);
	}
});

test('terminal microphone mute survives failed server sync and reconnect restore', async ({ browser }, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	await context.addInitScript(() => {
		window.__ripcordE2eRawAudioTracks = [];
		const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (constraints) => {
			const stream = await nativeGetUserMedia(constraints);
			if (constraints?.audio) {
				window.__ripcordE2eRawAudioTracks?.push(...stream.getAudioTracks());
			}
			return stream;
		};

		const nativeSend = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			if (
				window.__ripcordE2eFailNextVoiceStateUpdate &&
				typeof data === 'string' &&
				data.includes('voice.updateState')
			) {
				window.__ripcordE2eFailNextVoiceStateUpdate = false;
				this.close(4013, 'Injected terminal microphone state failure');
				return;
			}

			nativeSend.call(this, data);
		};
	});

	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const credentials = credentialsFor(testInfo);
	await login(page, credentials);
	const peer = { context, page, credentials };
	const microphonePublications: string[] = [];
	page.on('console', (message) => {
		if (message.text().includes('Microphone audio producer created')) {
			microphonePublications.push(message.text());
		}
	});

	try {
		await joinVoice(page);
		await page.waitForFunction(() => (window.__ripcordE2eRawAudioTracks?.length ?? 0) === 1);
		await expect.poll(() => microphonePublications.length).toBe(1);

		for (let recoveryAttempt = 1; recoveryAttempt <= 3; recoveryAttempt += 1) {
			await page.evaluate(() => {
				window.__ripcordE2eRawAudioTracks?.at(-1)?.dispatchEvent(new Event('ended'));
			});
			await page.waitForFunction(
				(expectedTrackCount) => (window.__ripcordE2eRawAudioTracks?.length ?? 0) === expectedTrackCount,
				recoveryAttempt + 1,
			);
			await expect.poll(() => microphonePublications.length).toBe(recoveryAttempt + 1);
		}

		await page.evaluate(() => {
			window.__ripcordE2eFailNextVoiceStateUpdate = true;
			window.__ripcordE2eRawAudioTracks?.at(-1)?.dispatchEvent(new Event('ended'));
		});

		await expect(page.getByTitle('Unmute microphone')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTitle('Unmute microphone')).toBeVisible();
		expect(await page.evaluate(() => window.__ripcordE2eFailNextVoiceStateUpdate)).toBe(false);
		expect(await page.evaluate(() => window.__ripcordE2eRawAudioTracks?.length ?? 0)).toBe(4);
		expect(
			await page.evaluate(
				() => window.__ripcordE2eRawAudioTracks?.filter((track) => track.readyState === 'live').length ?? 0,
			),
		).toBe(0);

		const observer = await createPeer(browser, credentialsFor(testInfo, 'observer'));
		try {
			await joinVoice(observer.page);
			await expect.poll(() => getOnlyRemoteMicMuted(observer.page)).toBe(true);
		} finally {
			await disposePeer(observer);
		}

		await page.waitForTimeout(2_000);
		expect(microphonePublications).toHaveLength(4);

		await page.getByTitle('Unmute microphone').click();
		await expect(page.getByTitle('Mute microphone')).toBeVisible();
		await page.waitForFunction(() => (window.__ripcordE2eRawAudioTracks?.length ?? 0) === 5);
	} finally {
		await disposePeer(peer);
	}
});

test('an immediate failure after a slow transport rebuild stays in the rapid circuit', async ({
	browser,
}, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));
	const recoveryEvents: string[] = [];
	peer.page.on('console', (message) => {
		const text = message.text();
		if (
			text.includes('Voice transport recovery completed successfully') ||
			text.includes('Rapid voice transport recovery exhausted')
		) {
			recoveryEvents.push(text);
		}
	});

	try {
		await peer.page.evaluate(() => {
			const nativeNow = Date.now.bind(Date);
			window.__ripcordE2eNowOffsetMs = 0;
			Date.now = () => nativeNow() + (window.__ripcordE2eNowOffsetMs ?? 0);
		});
		await joinVoice(peer.page);

		for (let cycle = 1; cycle <= 3; cycle += 1) {
			await forceNewestConnectedPeerConnectionFailure(peer.page);
			if (cycle === 1) {
				// Advance the application clock only after the first failure was
				// accepted. The replacement succeeds more than one old stability
				// interval later, then the next failure arrives immediately.
				await peer.page.evaluate(() => {
					window.__ripcordE2eNowOffsetMs = 31_000;
				});
			}
			await expect
				.poll(
					() =>
						recoveryEvents.filter((event) => event.includes('Voice transport recovery completed successfully')).length,
					{ timeout: 20_000 },
				)
				.toBe(cycle);
		}

		await forceNewestConnectedPeerConnectionFailure(peer.page);
		await expect(peer.page.getByTitle('Leave voice')).toHaveCount(0, { timeout: 20_000 });
		await expect
			.poll(() => recoveryEvents.filter((event) => event.includes('Rapid voice transport recovery exhausted')).length)
			.toBe(1);
		await peer.page.waitForTimeout(2_000);
		expect(
			recoveryEvents.filter((event) => event.includes('Voice transport recovery completed successfully')),
		).toHaveLength(3);
	} finally {
		await clearServerVoiceSession(browser, peer.credentials).catch(() => {});
		await disposePeer(peer);
	}
});

test('unconsumable remote audio exhausts its producer-scoped repair budget', async ({ browser }, testInfo) => {
	test.setTimeout(40_000);
	const watcherContext = await browser.newContext();
	await installPcHook(watcherContext);
	await watcherContext.addInitScript(() => {
		const nativeSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
		RTCPeerConnection.prototype.setRemoteDescription = function (description) {
			if (description.type === 'offer' && description.sdp?.includes('m=audio')) {
				return Promise.reject(new DOMException('Injected remote audio failure', 'OperationError'));
			}
			return Reflect.apply(nativeSetRemoteDescription, this, [description]);
		};

		const nativeSetTimeout = window.setTimeout.bind(window);
		window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
			const scaledDelay = delay !== undefined && delay >= 14_000 && delay <= 61_000 ? delay / 100 : delay;
			return nativeSetTimeout(handler, scaledDelay, ...args);
		}) as typeof window.setTimeout;
	});
	const watcherPage = await watcherContext.newPage();
	await suppressViteHmrReload(watcherPage);
	const watcherCredentials = credentialsFor(testInfo, 'watcher');
	await login(watcherPage, watcherCredentials);
	const watcher = { context: watcherContext, page: watcherPage, credentials: watcherCredentials };
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	const repairEvents: string[] = [];
	watcher.page.on('console', (message) => {
		const text = message.text();
		if (
			text.includes('Repairing stale pending voice stream') ||
			text.includes('Remote media repair budget exhausted')
		) {
			repairEvents.push(text);
		}
	});

	try {
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await expect
			.poll(() => repairEvents.filter((event) => event.includes('Remote media repair budget exhausted')).length, {
				timeout: 20_000,
			})
			.toBe(1);
		expect(repairEvents.filter((event) => event.includes('Repairing stale pending voice stream'))).toHaveLength(3);

		await watcher.page.waitForTimeout(2_000);
		expect(repairEvents.filter((event) => event.includes('Repairing stale pending voice stream'))).toHaveLength(3);
	} finally {
		await disposePeer(producer);
		await disposePeer(watcher);
	}
});

test('the latest microphone intent wins across repeated reconnects', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await peer.page.getByTitle('Mute microphone').click();
		await expect(peer.page.getByTitle('Unmute microphone')).toBeVisible();
		await dropAppWebSocket(peer.page);

		await peer.page.getByTitle('Unmute microphone').click();
		await expect(peer.page.getByTitle('Mute microphone')).toBeVisible();
		await dropAppWebSocket(peer.page);

		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(peer.page.getByTitle('Mute microphone')).toBeVisible();
	} finally {
		await disposePeer(peer);
	}
});

test('a stopped camera is not resurrected by reconnect recovery', async ({ browser }, testInfo) => {
	const peer = await createPeer(browser, credentialsFor(testInfo));

	try {
		await joinVoice(peer.page);
		await startCamera(peer.page);
		await expectOutboundVideoFlow(peer.page, 'camera to start sending');
		await stopCamera(peer.page);

		await dropAppWebSocket(peer.page);
		await expect(peer.page.getByText('Connected', { exact: true }).first()).toBeVisible();
		await expect(peer.page.getByTitle('Start video')).toBeVisible();
		await expectLocalVideoStopped(peer.page);
	} finally {
		await disposePeer(peer);
	}
});

for (const scenario of [
	{ action: 'kick', heading: 'You have been kicked' },
	{ action: 'ban', heading: 'You have been banned' },
] as const) {
	test(`an actual owner ${scenario.action} stops local media and exits voice`, async ({ browser }, testInfo) => {
		const peer = await createPeer(browser, credentialsFor(testInfo));

		try {
			await joinVoice(peer.page);
			await startCamera(peer.page);
			await expectOutboundVideoFlow(peer.page, 'camera to start sending');

			await moderatePeer(browser, peer, scenario.action);

			await expect(peer.page.getByRole('heading', { name: scenario.heading })).toBeVisible({ timeout: 30_000 });
			await expect(peer.page.getByTitle('Leave voice')).toHaveCount(0);
			await expectLocalVideoStopped(peer.page);
		} finally {
			if (scenario.action === 'ban') {
				await moderatePeer(browser, peer, 'unban', { updateDisplayName: false }).catch(() => {});
			}
			await clearServerVoiceSession(browser, peer.credentials).catch(() => {});
			await disposePeer(peer);
		}
	});
}
