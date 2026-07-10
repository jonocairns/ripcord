import { expect, test } from '@playwright/test';
import {
	installPcHook,
	joinVoice,
	leaveVoice,
	login,
	openReconnectLab,
	pcStats,
	startCamera,
	suppressViteHmrReload,
	waitForStats,
} from '../helpers/app';

// FSM recovery paths introduced by the voice session machine (PR #277). Each
// scenario drives a distinct reducer path through the app's own ReconnectLab
// fault injection:
//
//   1. transport failure     → 'rebuilding' phase (RebuildTransports commands)
//   2. failed restore + drop → 'reconnecting' retryDelay loop (RestoreFailed →
//                              RetryDelay → RestoreVoiceSession)
//   3. rapid WS flap         → repeated WsDropped while reconnecting (pending
//                              refresh without generation churn)
//   4. restore conflict      → terminal give-up path (ClearFailedSession):
//                              user is dropped cleanly, sees the conflict toast,
//                              and the sidebar must NOT be stuck on
//                              "Reconnecting voice..." afterwards.

async function clickLabAction(page: import('@playwright/test').Page, name: string) {
	await openReconnectLab(page);
	await page.getByRole('button', { name }).click();
}

test('in-session transport failure rebuilds and camera resumes', async ({ page, context }) => {
	await installPcHook(context);
	await suppressViteHmrReload(page);
	await login(page, 'sharkord', 'sharkord');
	await joinVoice(page, 'Gaming Room');
	try {
		await startCamera(page);
		await waitForStats(page, (s) => s.outboundVideoBytes > 0, 'camera to start sending');

		// Server emits VOICE_TRANSPORT_FAILED for this user — the machine must
		// enter 'rebuilding', tear down and recreate the transports, and end
		// 'connected' again without the user leaving voice.
		await clickLabAction(page, 'Emit transport failure (ICE-only)');

		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTitle('Leave voice')).toBeVisible();

		// Producers were republished onto the rebuilt transport: bytes climb again.
		const post = await pcStats(page);
		await waitForStats(
			page,
			(s) => s.outboundVideoBytes > post.outboundVideoBytes,
			'camera to resume sending after transport rebuild',
			30_000,
		);
	} finally {
		await leaveVoice(page).catch(() => {});
	}
});

test('a failed restore is retried and recovery completes', async ({ page, context }) => {
	await installPcHook(context);
	await suppressViteHmrReload(page);
	await login(page, 'sharkord', 'sharkord');
	await joinVoice(page, 'Lounge');
	try {
		await startCamera(page);
		await waitForStats(page, (s) => s.outboundVideoBytes > 0, 'camera to start sending');

		// Primes exactly one forced restoreOrJoin failure, then drops the WS. The
		// machine's first RestoreVoiceSession fails → RetryDelay → second attempt
		// succeeds. Ends connected with media flowing.
		await clickLabAction(page, 'Fail next restore + drop WS');

		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 40_000 });

		const post = await pcStats(page);
		await waitForStats(
			page,
			(s) => s.outboundVideoBytes > post.outboundVideoBytes,
			'camera to resume sending after retried restore',
			30_000,
		);
	} finally {
		await leaveVoice(page).catch(() => {});
	}
});

test('rapid WS flapping settles back to a connected voice session', async ({ page, context }) => {
	test.setTimeout(120_000);
	await installPcHook(context);
	await suppressViteHmrReload(page);
	await login(page, 'sharkord', 'sharkord');
	await joinVoice(page, 'Gaming Room');
	try {
		await startCamera(page);
		await waitForStats(page, (s) => s.outboundVideoBytes > 0, 'camera to start sending');

		// 4 WS drops over 24s: repeated WsDropped events land while the machine is
		// already reconnecting (pending refresh, no generation churn) and right
		// after it re-enters connected (fresh recovery cycle). It must converge.
		await clickLabAction(page, 'Rapid WS flap x4');
		await page.waitForTimeout(28_000);

		await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 40_000 });
		await expect(page.getByTitle('Leave voice')).toBeVisible();

		const post = await pcStats(page);
		await waitForStats(
			page,
			(s) => s.outboundVideoBytes > post.outboundVideoBytes,
			'camera to keep sending after WS flapping settles',
			30_000,
		);
	} finally {
		await leaveVoice(page).catch(() => {});
	}
});

test('terminal restore conflict drops voice cleanly without a stuck reconnect indicator', async ({ browser }) => {
	// Genuine session takeover — automates the lab's manual check "two tabs,
	// same user, same channel". The lab's one-shot 'Force restore conflict'
	// prime can be consumed by a restore attempt whose response dies with the
	// closing socket (retry then succeeds), so instead: tab A's restore is
	// delayed 5s server-side while tab B (same user) joins the channel. Every
	// restore attempt from A then hits a real VOICE_SESSION_OWNED_ELSEWHERE.
	test.setTimeout(120_000);
	const contextA = await browser.newContext();
	const contextB = await browser.newContext();
	const a = await contextA.newPage();
	const b = await contextB.newPage();

	try {
		await installPcHook(contextA);
		await installPcHook(contextB);
		await suppressViteHmrReload(a);
		await suppressViteHmrReload(b);

		await login(a, 'sharkord', 'sharkord');
		await joinVoice(a, 'Work Mode');
		await login(b, 'sharkord', 'sharkord');

		// A: prime a 5s restore delay and drop the WS; while A's restoreOrJoin is
		// held, B takes over the voice session.
		await clickLabAction(a, 'Slow restore + drop WS');
		await joinVoice(b, 'Work Mode');

		// classifyVoiceReconnectError marks the conflict terminal, so A's machine
		// must take the give-up path: ClearFailedSession →
		// clearOwnVoiceSessionAfterReconnectFailure (reason toast + full local clear).
		await expect(a.getByText(/taken over by another connection/i)).toBeVisible({ timeout: 30_000 });

		// A is fully out of voice: no voice controls left.
		await expect(a.getByTitle('Leave voice')).toHaveCount(0, { timeout: 15_000 });

		// Regression guard: the give-up path must clear reconnectingSince
		// everywhere. If the projection is left stale, the sidebar shows
		// "Reconnecting voice..." forever (the indicator renders when out of voice
		// with reconnectingSince set). Give its show-delay time to elapse first.
		await a.waitForTimeout(4_000);
		await expect(a.getByText('Reconnecting voice...')).toHaveCount(0);

		// A's app stays usable, and B was not evicted by A's failed restore.
		await expect(a.getByText('VOICE CHANNELS')).toBeVisible();
		await expect(b.getByText('Connected', { exact: true }).first()).toBeVisible();
	} finally {
		await leaveVoice(b).catch(() => {});
		await contextA.close();
		await contextB.close();
	}
});
