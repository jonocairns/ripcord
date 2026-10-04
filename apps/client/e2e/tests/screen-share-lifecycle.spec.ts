import { expect, test } from '@playwright/test';
import { createPeer, credentialsFor, disposePeer, joinVoice, leaveVoice, pcStats } from '../helpers/app';
import { expectCapture, installScreenCapture, startScreenShare, watchScreenShare } from '../helpers/screen-share';

declare global {
	interface Window {
		__ripcordE2eDisplayGate?: { held: number; release: () => void };
	}
}

test('leaving during deferred screen acquisition clears starting state and allows sharing after rejoin', async ({
	browser,
}, testInfo) => {
	const watcher = await createPeer(browser, credentialsFor(testInfo, 'watcher'));
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	try {
		await installScreenCapture(producer.page);
		// Hold the baseline's unchanged video-only canvas acquisition result.
		// This is an acquisition dependency mock, not native picker coverage.
		await producer.page.evaluate(() => {
			const acquire = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const gate = { held: 0, release };
			window.__ripcordE2eDisplayGate = gate;
			navigator.mediaDevices.getDisplayMedia = async (options) => {
				const capture = await acquire(options);
				gate.held += 1;
				await pending;
				return capture;
			};
		});
		await joinVoice(watcher.page);
		await joinVoice(producer.page);
		await producer.page.getByTitle('Share screen', { exact: true }).click();
		await producer.page.waitForFunction(() => window.__ripcordE2eDisplayGate?.held === 1);
		await expect(producer.page.getByText('Starting screen share...', { exact: true })).toBeVisible();
		await leaveVoice(producer.page);
		await producer.page.evaluate(() => window.__ripcordE2eDisplayGate?.release());
		await expectCapture(producer.page, 'ended');
		await joinVoice(producer.page);
		await expect(producer.page.getByText('Starting screen share...', { exact: true })).toHaveCount(0);
		await startScreenShare(producer.page);
		const secondCapture = await producer.page.evaluate(() => ({
			calls: window.__ripcordE2eDisplayCaptureCalls,
			tracks: window.__ripcordE2eDisplayTracks?.map((track) => ({ id: track.id, state: track.readyState })),
		}));
		expect(secondCapture.calls).toBe(2);
		expect(secondCapture.tracks).toEqual([
			{ id: expect.any(String), state: 'ended' },
			{ id: expect.any(String), state: 'live' },
		]);
		expect(secondCapture.tracks?.[0]?.id).not.toBe(secondCapture.tracks?.[1]?.id);
		await watchScreenShare(watcher.page);
		await producer.page.getByTitle('Stop sharing', { exact: true }).click();
		await expect
			.poll(() => producer.page.evaluate(() => window.__ripcordE2eDisplayTracks?.map((track) => track.readyState)))
			.toEqual(['ended', 'ended']);
		await expect.poll(async () => (await pcStats(producer.page)).liveOutboundVideoTracks).toBe(0);
		await expect(watcher.page.locator('button:has(svg.sidebar-live-indicator--screen)')).toHaveCount(0);
		await expect
			.poll(() =>
				watcher.page.evaluate(() =>
					window.__ripcordE2eScreenReceiverTracks?.every((track) => track.readyState === 'ended'),
				),
			)
			.toBe(true);
	} finally {
		await producer.page.evaluate(() => window.__ripcordE2eDisplayGate?.release()).catch(() => {});
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});
