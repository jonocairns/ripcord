import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const CLIENT_ROOT = import.meta.dirname;
const SERVER_ROOT = path.resolve(CLIENT_ROOT, '../server');

const FAKE_MEDIA_ARGS = [
	'--use-fake-device-for-media-stream',
	'--use-fake-ui-for-media-stream',
	'--autoplay-policy=no-user-gesture-required',
	'--disable-features=WebRtcHideLocalIpsWithMdns',
];

export default defineConfig({
	testDir: './e2e/tests',
	outputDir: './test-results/e2e',
	timeout: 90_000,
	expect: { timeout: 15_000 },
	workers: 1,
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: 'http://127.0.0.1:5173',
		actionTimeout: 15_000,
		navigationTimeout: 20_000,
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: {
			args: FAKE_MEDIA_ARGS,
		},
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: 'bun ../client/e2e/start-server.ts',
			cwd: SERVER_ROOT,
			url: 'http://127.0.0.1:4991/healthz',
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command: 'bun run dev -- --host 127.0.0.1 --port 5173 --strictPort',
			cwd: CLIENT_ROOT,
			url: 'http://127.0.0.1:5173',
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
