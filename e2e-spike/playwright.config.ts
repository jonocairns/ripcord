import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Isolated WebRTC e2e spike — its own node_modules, deliberately outside the bun
// workspace so it never touches the tracked root lockfile.
const REPO_ROOT = path.resolve(__dirname, '..');

// By default point at an already-cached chromium build (Playwright 1.61 otherwise
// wants to download 1228). Override with SPIKE_CHROMIUM, or delete this and run
// `npx playwright install chromium` to use the matched browser. WebRTC + fake
// media work fine on the older build.
const CACHED_CHROMIUM =
	process.env.SPIKE_CHROMIUM ??
	`${process.env.HOME}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`;

// Deterministic synthetic media so getUserMedia/getDisplayMedia never touch hardware
// and never prompt. This is the crux of headless WebRTC e2e.
const FAKE_MEDIA_ARGS = [
	'--use-fake-device-for-media-stream',
	'--use-fake-ui-for-media-stream',
	'--autoplay-policy=no-user-gesture-required',
	// Loopback ICE against 127.0.0.1:40000 works without STUN; keep it quiet.
	'--disable-features=WebRtcHideLocalIpsWithMdns',
];

export default defineConfig({
	testDir: './tests',
	// Seeds the dedicated Owner-role e2e peer (via bun) before any test runs.
	globalSetup: './global-setup.ts',
	// WebRTC signalling + reconnect timers are slow; give room but keep it bounded.
	timeout: 90_000,
	expect: { timeout: 15_000 },
	// Bound individual actions so a missing element fails fast instead of hanging
	// until the whole-test deadline (which masks *where* the flow broke).
	// (set on `use` below via actionTimeout)
	// Serial: the dev server is a single shared backend with shared DB/voice state.
	workers: 1,
	fullyParallel: false,
	// One retry absorbs transient nav/connectivity flakes against the shared dev server.
	retries: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:5173',
		actionTimeout: 15_000,
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: {
			executablePath: CACHED_CHROMIUM,
			args: FAKE_MEDIA_ARGS,
		},
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// Reuse the dev server if it's already up (it is, in this session); otherwise boot it.
	webServer: {
		command: 'bun run start:web',
		cwd: REPO_ROOT,
		url: 'http://127.0.0.1:5173',
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
