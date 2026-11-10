import { expect, type Page, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	installPcHook,
	joinVoice,
	login,
	moderatePeer,
	suppressViteHmrReload,
} from '../helpers/app';
import { expectMicrophoneFlow } from '../helpers/microphone';
import { installServerUnreachableFault } from '../helpers/server-unreachable';
import { runVoiceRecoveryTest } from '../helpers/voice-recovery-test';
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

test('a connection replaced after the disconnect screen is closed and Leave voice still reaches the server', async ({
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

			await fault.cut();
			await expect(page.getByText('Connection lost', { exact: true })).toBeVisible({ timeout: 45_000 });
			expect(await page.evaluate(() => navigator.onLine)).toBe(true);
			await expect.poll(() => fault.heldCount()).toBe(2);
			fault.restoreNewest();

			await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 30_000 });
			await expect(page.getByTitle('Leave voice')).toBeVisible({ timeout: 30_000 });
			await expectMicrophoneFlow(page, 'outbound');
			await expectMicrophoneFlow(watcher.page, 'inbound');
			const before = fault.connectedCount();
			fault.restore();
			await expect.poll(() => fault.connectedCount()).toBe(before + 1);
			// The retired client must close after its held connection is released.
			await expect.poll(() => fault.openCount(), { timeout: 15_000 }).toBe(1);
			const { ownUserId } = await voiceMembership(page);
			await page.getByTitle('Leave voice', { exact: true }).click();
			await expect
				.poll(async () => (await voiceMembership(watcher.page)).memberIds, { timeout: 15_000 })
				.not.toContain(ownUserId);
			await expect(
				page.getByText(/reconnect failed|failed to reconnect|failed to leave voice|something went wrong/i),
			).toHaveCount(0);
		},
		attachDiagnostics: async () => {
			await testInfo.attach('server-voice-events', {
				body: JSON.stringify(await readVoiceServerEvents(), null, 2),
				contentType: 'application/json',
			});
		},
		resumeOutage: () => restoreOutage?.(),
		disposePeers: [async () => disposeProducer?.(), () => disposePeer(watcher)],
	});
});

test('a banned client stops connecting', async ({ browser }, testInfo) => {
	const context = await browser.newContext();
	await installPcHook(context);
	const page = await context.newPage();
	const credentials = credentialsFor(testInfo, 'producer');
	const producer = { context, page, credentials };
	try {
		await suppressViteHmrReload(page);
		const fault = await installServerUnreachableFault(page);
		await login(page, credentials);
		await moderatePeer(browser, producer, 'ban');
		await expect(page.getByText('You have been banned', { exact: false })).toBeVisible();
		const before = fault.connectedCount();
		// Absence check: observe long enough to detect the old reconnect loop.
		await page.waitForTimeout(5_000);
		expect(fault.connectedCount() - before).toBeLessThanOrEqual(1);
	} finally {
		try {
			await moderatePeer(browser, producer, 'unban', { updateDisplayName: false });
		} finally {
			await disposePeer(producer);
		}
	}
});
