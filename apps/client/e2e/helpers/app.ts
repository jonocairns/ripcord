import { type Browser, type BrowserContext, expect, type Page, type TestInfo } from '@playwright/test';
import { callTrpc } from './trpc';

const DEFAULT_VOICE_CHANNEL = 'General Voice';

type PcStats = {
	peerConnections: number;
	openPeerConnections: number;
	inboundVideoBytes: number;
	outboundVideoBytes: number;
	liveInboundVideoTracks: number;
	liveOutboundVideoTracks: number;
};

declare global {
	interface Window {
		__ripcordE2ePeerConnections?: RTCPeerConnection[];
		__ripcordE2eStats?: () => Promise<PcStats>;
		__ripcordE2eWebSockets?: WebSocket[];
		__ripcordE2eCloseAppWebSocket?: () => boolean;
	}
}

const PC_HOOK = `
(() => {
  const Native = window.RTCPeerConnection;
  if (!Native || window.__ripcordE2eStats) return;

  const peerConnections = [];
  window.__ripcordE2ePeerConnections = peerConnections;
  window.RTCPeerConnection = function (...args) {
    const peerConnection = new Native(...args);
    peerConnections.push(peerConnection);
    return peerConnection;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  window.__ripcordE2eStats = async () => {
    const aggregate = {
      peerConnections: peerConnections.length,
      openPeerConnections: 0,
      inboundVideoBytes: 0,
      outboundVideoBytes: 0,
      liveInboundVideoTracks: 0,
      liveOutboundVideoTracks: 0,
    };

    for (const peerConnection of peerConnections) {
      if (peerConnection.connectionState !== 'closed') {
        aggregate.openPeerConnections += 1;
      }

      aggregate.liveInboundVideoTracks += peerConnection
        .getReceivers()
        .filter(({ track }) => track?.kind === 'video' && track.readyState === 'live').length;
      aggregate.liveOutboundVideoTracks += peerConnection
        .getSenders()
        .filter(({ track }) => track?.kind === 'video' && track.readyState === 'live').length;

      let report;
      try {
        report = await peerConnection.getStats();
      } catch {
        continue;
      }

      report.forEach((stat) => {
        const isVideo = stat.kind === 'video' || stat.mediaType === 'video';
        if (stat.type === 'inbound-rtp' && isVideo) {
          aggregate.inboundVideoBytes += stat.bytesReceived || 0;
        }
        if (stat.type === 'outbound-rtp' && isVideo) {
          aggregate.outboundVideoBytes += stat.bytesSent || 0;
        }
      });
    }

    return aggregate;
  };
})();
`;

const WS_HOOK = `
(() => {
  const Native = window.WebSocket;
  if (!Native || window.__ripcordE2eCloseAppWebSocket) return;

  const webSockets = [];
  window.__ripcordE2eWebSockets = webSockets;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      webSockets.push(this);
    }
  };
  window.__ripcordE2eCloseAppWebSocket = () => {
    const socket = webSockets.findLast(({ readyState, url }) => readyState === Native.OPEN && !url.includes(':5173'));
    if (!socket) return false;
    socket.close(4013, 'Playwright connection fault');
    return true;
  };
})();
`;

type PeerCredentials = {
	identity: string;
	password: string;
};

type Peer = {
	context: BrowserContext;
	page: Page;
	credentials: PeerCredentials;
};

type ModerationAction = 'ban' | 'kick' | 'unban';

// The seeded owner account; development servers keep its identity predictable.
const OWNER_CREDENTIALS: PeerCredentials = { identity: 'ripcord', password: 'ripcord' };

const installPcHook = async (context: BrowserContext): Promise<void> => {
	await context.addInitScript(`${PC_HOOK}\n${WS_HOOK}`);
};

const suppressViteHmrReload = async (page: Page): Promise<void> => {
	await page.routeWebSocket(/:5173\//, () => {});
};

const pcStats = async (page: Page): Promise<PcStats> => {
	return page.evaluate(async () => {
		if (!window.__ripcordE2eStats) {
			throw new Error('The WebRTC stats hook was not installed');
		}

		return window.__ripcordE2eStats();
	});
};

const waitForStats = async (
	page: Page,
	predicate: (stats: PcStats) => boolean,
	label: string,
	timeout = 30_000,
): Promise<PcStats> => {
	const startedAt = Date.now();
	let lastStats: PcStats | undefined;

	while (Date.now() - startedAt < timeout) {
		lastStats = await pcStats(page);
		if (predicate(lastStats)) {
			return lastStats;
		}

		await page.waitForTimeout(500);
	}

	throw new Error(`Timed out waiting for ${label}. Last WebRTC stats: ${JSON.stringify(lastStats)}`);
};

const dropAppWebSocket = async (page: Page, options: { waitForReconnect?: boolean } = {}): Promise<void> => {
	const socketCount = await page.evaluate(() => window.__ripcordE2eWebSockets?.length ?? 0);
	const closed = await page.evaluate(() => window.__ripcordE2eCloseAppWebSocket?.() ?? false);

	if (!closed) {
		throw new Error('No open application WebSocket was available to close');
	}

	if (options.waitForReconnect !== false) {
		await page.waitForFunction(
			(previousSocketCount) =>
				(window.__ripcordE2eWebSockets?.length ?? 0) > previousSocketCount &&
				(window.__ripcordE2eWebSockets ?? []).some(
					({ readyState, url }) => readyState === WebSocket.OPEN && !url.includes(':5173'),
				),
			socketCount,
			{ timeout: 20_000 },
		);
	}
};

const forceNewestConnectedPeerConnectionFailure = async (page: Page): Promise<void> => {
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

const expectOutboundVideoFlow = async (page: Page, label: string, timeout = 30_000): Promise<void> => {
	const baseline = await pcStats(page);

	await waitForStats(
		page,
		(stats) => stats.liveOutboundVideoTracks > 0 && stats.outboundVideoBytes > baseline.outboundVideoBytes,
		label,
		timeout,
	);
};

const expectInboundVideoFlow = async (page: Page, label: string, timeout = 30_000): Promise<void> => {
	const baseline = await pcStats(page);

	await waitForStats(
		page,
		(stats) => stats.liveInboundVideoTracks > 0 && stats.inboundVideoBytes > baseline.inboundVideoBytes,
		label,
		timeout,
	);
};

const expectInboundVideoIdle = async (page: Page, label: string, timeout = 15_000): Promise<void> => {
	await expect(page.locator('video')).toHaveCount(0, { timeout });

	const startedAt = Date.now();
	let lastDelta: number | undefined;

	while (Date.now() - startedAt < timeout) {
		const baseline = await pcStats(page);
		await page.waitForTimeout(2_000);
		const current = await pcStats(page);
		lastDelta = current.inboundVideoBytes - baseline.inboundVideoBytes;

		if (lastDelta < 20_000) {
			return;
		}
	}

	throw new Error(`Timed out waiting for ${label}. Last two-second inbound byte delta: ${lastDelta}`);
};

const expectLocalVideoStopped = async (page: Page): Promise<void> => {
	await waitForStats(page, (stats) => stats.liveOutboundVideoTracks === 0, 'local video tracks to stop', 10_000);
};

const credentialsFor = (testInfo: TestInfo, suffix = 'peer'): PeerCredentials => {
	const stableTitle = testInfo.titlePath
		.join('-')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48);
	const identity = `e2e-${testInfo.workerIndex}-${stableTitle}-${suffix}`;

	return { identity, password: `${identity}-password` };
};

const login = async (page: Page, credentials: PeerCredentials): Promise<void> => {
	await page.goto('/', { waitUntil: 'domcontentloaded' });
	await page.locator('input').first().fill(credentials.identity);
	await page.locator('input[type="password"]').fill(credentials.password);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 20_000 });
};

const createPeer = async (browser: Browser, credentials: PeerCredentials): Promise<Peer> => {
	const context = await browser.newContext();
	await installPcHook(context);
	const page = await context.newPage();
	await suppressViteHmrReload(page);
	await login(page, credentials);

	return { context, page, credentials };
};

const displayNameFor = (credentials: PeerCredentials): string => {
	let hash = 0;

	for (const character of credentials.identity) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	}

	return `E2E-${hash.toString(36)}`;
};

const moderatePeer = async (
	browser: Browser,
	peer: Peer,
	action: ModerationAction,
	options: { updateDisplayName?: boolean } = {},
): Promise<void> => {
	const displayName = displayNameFor(peer.credentials);
	if (options.updateDisplayName !== false) {
		await callTrpc(peer.page, {
			path: ['users', 'update'],
			method: 'mutate',
			input: { name: displayName, bannerColor: '#FFFFFF' },
		});
	}

	const owner = await createPeer(browser, OWNER_CREDENTIALS);

	try {
		const allUsers = await callTrpc(owner.page, { path: ['users', 'getAll'], method: 'query' });
		if (!Array.isArray(allUsers)) {
			throw new Error('The users.getAll query returned an invalid response');
		}

		const target: unknown = allUsers.find(
			(user) => typeof user === 'object' && user !== null && Reflect.get(user, 'name') === displayName,
		);
		const userId = typeof target === 'object' && target !== null ? Reflect.get(target, 'id') : undefined;
		if (typeof userId !== 'number') {
			throw new Error(`Could not find moderation target ${displayName}`);
		}

		await callTrpc(owner.page, {
			path: ['users', action],
			method: 'mutate',
			input: action === 'unban' ? { userId } : { userId, reason: `Playwright ${action}` },
		});
	} finally {
		await disposePeer(owner);
	}
};

const joinVoice = async (page: Page, channel = DEFAULT_VOICE_CHANNEL): Promise<void> => {
	await page.getByRole('button', { name: channel, exact: true }).click();
	await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
};

const leaveVoice = async (page: Page): Promise<void> => {
	const leaveButton = page.getByTitle('Leave voice');
	if (await leaveButton.isVisible().catch(() => false)) {
		await page.evaluate(async () => {
			const modulePath = '/src/features/server/voice/actions.ts';
			const voiceActions: unknown = await import(modulePath);

			if (typeof voiceActions !== 'object' || voiceActions === null) {
				throw new Error('Could not load the voice action module');
			}

			const leave = Reflect.get(voiceActions, 'leaveVoice');
			if (typeof leave !== 'function') {
				throw new Error('The voice action module does not export leaveVoice');
			}

			await leave();
		});
		await expect(leaveButton).toHaveCount(0);
	}
};

const disposePeer = async (peer: Peer): Promise<void> => {
	await peer.context.setOffline(false).catch(() => {});
	await leaveVoice(peer.page).catch(() => {});
	await peer.context.close();
};

const clearServerVoiceSession = async (browser: Browser, credentials: PeerCredentials): Promise<void> => {
	const cleanupPeer = await createPeer(browser, credentials);

	try {
		await joinVoice(cleanupPeer.page);
	} finally {
		await disposePeer(cleanupPeer);
	}
};

const startCamera = async (page: Page): Promise<void> => {
	await page.getByTitle('Start video').click();
	await expect(page.getByTitle('Stop video')).toBeVisible();
};

const stopCamera = async (page: Page): Promise<void> => {
	await page.getByTitle('Stop video').click();
	await expect(page.getByTitle('Start video')).toBeVisible();
};

const remoteCameraIndicator = (page: Page) => page.locator('button:has(svg.sidebar-live-indicator--video)');

const watchRemoteCamera = async (page: Page): Promise<void> => {
	const indicator = remoteCameraIndicator(page).first();
	await expect(indicator).toBeVisible({ timeout: 20_000 });
	await indicator.click();
};

export type { PcStats, Peer, PeerCredentials };
export {
	clearServerVoiceSession,
	createPeer,
	credentialsFor,
	DEFAULT_VOICE_CHANNEL,
	disposePeer,
	dropAppWebSocket,
	expectInboundVideoFlow,
	expectInboundVideoIdle,
	expectLocalVideoStopped,
	expectOutboundVideoFlow,
	forceNewestConnectedPeerConnectionFailure,
	installPcHook,
	joinVoice,
	leaveVoice,
	login,
	moderatePeer,
	OWNER_CREDENTIALS,
	pcStats,
	remoteCameraIndicator,
	startCamera,
	stopCamera,
	suppressViteHmrReload,
	waitForStats,
	watchRemoteCamera,
};
