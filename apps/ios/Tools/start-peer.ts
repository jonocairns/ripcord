import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { installFailureFixture } from './failure-fixture';

// A real browser peer using synthetic acquisition; no microphone/desktop capture.
const port = Number(process.env.PORT || 5193);
const root = import.meta.dirname;
const browser = await chromium.launch({
	headless: true,
	args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('Peer:', error.message));
page.on('console', (message) => {
	if (message.type() === 'error') console.error('Peer:', message.text());
});
const server = await createServer({
	root,
	configFile: false,
	server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [path.resolve(root, '../../..')] } },
	plugins: [
		{
			name: 'poc-peer-controls',
			configureServer(server) {
				installFailureFixture(server);
				server.middlewares.use('/fixture', async (req, res) => {
					res.setHeader('Content-Type', 'application/json');
					try {
						const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
						const result = await page.evaluate(
							async ({ action, value }) => {
								const peer = Reflect.get(window, 'pocPeer');
								if (!peer) throw new Error('Peer is not ready');
								return action ? peer.command(action, value) : peer.state();
							},
							{ action: url.searchParams.get('action'), value: url.searchParams.get('value') },
						);
						res.end(JSON.stringify(result ?? { ok: true }));
					} catch (error) {
						res.statusCode = 503;
						res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
					}
				});
			},
		},
	],
});
await server.listen();
await page.goto(`http://127.0.0.1:${port}`);
await page.waitForFunction(() => Reflect.has(window, 'pocPeer'), { timeout: 60_000 });
console.log('POC browser peer ready');
