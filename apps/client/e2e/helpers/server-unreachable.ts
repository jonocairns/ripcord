import type { Page, WebSocketRoute } from '@playwright/test';

// Keep replacement sockets CONNECTING until restore. Returning from a routed
// handler without connecting would report an open socket and cancel teardown.
const installServerUnreachableFault = async (page: Page) => {
	let cut = false;
	const pairs = new Set<{ socket: WebSocketRoute; server: WebSocketRoute }>();
	const waiting = new Set<() => void>();

	await page.routeWebSocket(
		(url) => url.port === '4991',
		async (socket) => {
			if (cut) await new Promise<void>((resolve) => waiting.add(resolve));
			const server = socket.connectToServer();
			const pair = { socket, server };
			pairs.add(pair);
			socket.onClose(async (code, reason) => {
				pairs.delete(pair);
				await server.close({ code, reason });
			});
			server.onClose(async (code, reason) => {
				pairs.delete(pair);
				await socket.close({ code, reason });
			});
		},
	);

	return {
		cut: async () => {
			cut = true;
			const livePairs = [...pairs];
			pairs.clear();
			await Promise.all(
				livePairs.flatMap(({ socket, server }) => {
					const options = { code: 4013, reason: 'Playwright server unreachable' };
					return [server.close(options), socket.close(options)];
				}),
			);
		},
		restore: () => {
			cut = false;
			for (const resolve of waiting) resolve();
			waiting.clear();
		},
	};
};

export { installServerUnreachableFault };
