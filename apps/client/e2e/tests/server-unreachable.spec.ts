import { expect, test } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	installPcHook,
	joinVoice,
	login,
	suppressViteHmrReload,
} from '../helpers/app';
import { expectMicrophoneFlow } from '../helpers/microphone';
import { installServerUnreachableFault } from '../helpers/server-unreachable';
import { runVoiceRecoveryTest } from '../helpers/voice-recovery-test';

test('voice restores after an online server outage reaches the disconnect screen', async ({ browser }, testInfo) => {
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
			fault.restore();

			await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 30_000 });
			await expect(page.getByTitle('Leave voice')).toBeVisible({ timeout: 30_000 });
			await expectMicrophoneFlow(page, 'outbound');
			await expectMicrophoneFlow(watcher.page, 'inbound');
			await expect(page.getByText(/failed to reconnect|something went wrong/i)).toHaveCount(0);
		},
		attachDiagnostics: async () => {},
		resumeOutage: () => restoreOutage?.(),
		disposePeers: [async () => disposeProducer?.(), () => disposePeer(watcher)],
	});
});
