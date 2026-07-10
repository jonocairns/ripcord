import { type BrowserContext, expect, type Page } from '@playwright/test';

// ── WebRTC stats hook ────────────────────────────────────────────────────────
// mediasoup-client builds its send/recv transports on plain RTCPeerConnections.
// We wrap the constructor before any app code runs so every PC is observable,
// then read getStats() to prove media actually flows — the only trustworthy
// signal in a headless WebRTC test (DOM alone can lie about a black/frozen tile).
const PC_HOOK = `
(() => {
  const Native = window.RTCPeerConnection;
  if (!Native || window.__pcHookInstalled) return;
  window.__pcHookInstalled = true;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  window.__pcStats = async () => {
    const agg = { inboundVideoBytes: 0, outboundVideoBytes: 0, inboundVideoTracks: 0, outboundVideoTracks: 0 };
    for (const pc of window.__pcs) {
      let report;
      try { report = await pc.getStats(); } catch { continue; }
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          agg.inboundVideoBytes += s.bytesReceived || 0;
          agg.inboundVideoTracks += 1;
        }
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          agg.outboundVideoBytes += s.bytesSent || 0;
          agg.outboundVideoTracks += 1;
        }
      });
    }
    return agg;
  };
})();
`;

export type PcStats = {
	inboundVideoBytes: number;
	outboundVideoBytes: number;
	inboundVideoTracks: number;
	outboundVideoTracks: number;
};

export async function installPcHook(context: BrowserContext) {
	await context.addInitScript(PC_HOOK);
}

// Vite's dev client reloads the page when its HMR websocket drops and the dev
// server becomes reachable again — e.g. after context.setOffline() windows.
// That reload wipes all client state mid-test and races the app's own voice
// recovery. Intercept the HMR socket (vite retries quietly when it never
// connects) so offline tests observe the app's real recovery, not a dev-server
// artifact. Production builds have no vite client, so nothing real is lost.
export async function suppressViteHmrReload(page: Page) {
	await page.routeWebSocket(/:5173\//, () => {
		// Never connect server-side: vite logs a connect failure and keeps
		// retrying without ever entering its "connection lost → reload" path.
	});
}

export function pcStats(page: Page): Promise<PcStats> {
	return page.evaluate(() => (window as unknown as { __pcStats: () => Promise<PcStats> }).__pcStats());
}

/** Poll until predicate over PC stats holds, or throw after `timeoutMs`. */
export async function waitForStats(
	page: Page,
	predicate: (s: PcStats) => boolean,
	label: string,
	timeoutMs = 25_000,
) {
	const start = Date.now();
	let last: PcStats | undefined;
	while (Date.now() - start < timeoutMs) {
		last = await pcStats(page);
		if (predicate(last)) return last;
		await page.waitForTimeout(750);
	}
	throw new Error(`waitForStats timed out waiting for: ${label}. last=${JSON.stringify(last)}`);
}

// ── App flows ────────────────────────────────────────────────────────────────
// New identities auto-register (allowNewUsers=true in dev seed), so peers can be
// minted on the fly. The bootstrap account is identity/password "sharkord".
export async function login(page: Page, identity: string, password = identity) {
	// The dev server can transiently abort a navigation (ERR_ABORTED) under load or
	// right after another test hammered connectivity — retry the initial load.
	for (let attempt = 0; ; attempt++) {
		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' });
			break;
		} catch (err) {
			if (attempt >= 2) throw err;
			await page.waitForTimeout(1000);
		}
	}
	await page.locator('input').first().waitFor({ state: 'visible' });
	await page.locator('input').first().fill(identity);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	// Sidebar categories only render once connected + synced.
	await expect(page.getByText('VOICE CHANNELS')).toBeVisible({ timeout: 20_000 });
}

export async function joinVoice(page: Page, channel: string) {
	// The clickable channel is the role=button row — NOT the outer text wrapper
	// that getByText().first() would grab (that div isn't interactive).
	const row = page.getByRole('button', { name: channel, exact: true });
	const connected = page.getByText('Connected', { exact: true }).first();
	// The first click can be a no-op if the sidebar is mid-update (e.g. right after
	// another test's session is still tearing down on the shared server). Re-clicking
	// an already-joined channel is itself a no-op, so retrying is safe.
	for (let attempt = 0; attempt < 3; attempt++) {
		await row.click();
		try {
			await expect(connected).toBeVisible({ timeout: 10_000 });
			return;
		} catch (err) {
			if (attempt === 2) throw err;
		}
	}
}

export const startCamera = (page: Page) => page.getByTitle('Start video').click();
export const stopCamera = (page: Page) => page.getByTitle('Stop video').click();
export const leaveVoice = (page: Page) => page.getByTitle('Leave voice').click();

// A remote camera is opt-in to watch here — clicking the "Open camera in stage"
// indicator on a peer's voice-user row is what establishes the ledger's watch
// intent and triggers the consume. Returns a locator for the indicator so callers
// can also assert it disappears when the sharer stops.
export const remoteCameraIndicator = (page: Page) =>
	page.locator('button:has(svg.sidebar-live-indicator--video)');

export async function watchRemoteCamera(page: Page) {
	const indicator = remoteCameraIndicator(page);
	await expect(indicator.first()).toBeVisible({ timeout: 20_000 });
	await indicator.first().click();
}

export async function openReconnectLab(page: Page) {
	const lab = page.getByRole('button', { name: 'Open reconnect lab' });
	// Toggle: only click to open if the panel isn't already showing.
	if (!(await page.getByText('Reconnect Lab', { exact: true }).isVisible().catch(() => false))) {
		await lab.click();
	}
	await expect(page.getByRole('button', { name: 'Drop WS (<60s)' })).toBeVisible();
}

export async function dropWsShort(page: Page) {
	await openReconnectLab(page);
	await page.getByRole('button', { name: 'Drop WS (<60s)' }).click();
}
