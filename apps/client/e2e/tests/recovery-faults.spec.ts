import { expect, test } from '@playwright/test';
import {
	clearServerVoiceSession,
	createPeer,
	credentialsFor,
	disposePeer,
	dropAppWebSocket,
	expectLocalVideoStopped,
	expectOutboundVideoFlow,
	joinVoice,
	moderatePeer,
	pcStats,
	startCamera,
	stopCamera,
	waitForStats,
} from '../helpers/app';

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
