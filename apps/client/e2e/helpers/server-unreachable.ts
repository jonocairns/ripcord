import type { Page, WebSocketRoute } from '@playwright/test';

// Keep replacement sockets CONNECTING until restore. Returning from a routed
// handler without connecting would report an open socket and cancel teardown.
const installServerUnreachableFault = async (page: Page) => {
	let cut = false;
	const pairs = new Set<{ socket: WebSocketRoute; server: WebSocketRoute }>();
	const waiting: (() => void)[] = [];
	let connectedCount = 0;
	let attemptCount = 0;
	const serverCloses: { code?: number; reason?: string }[] = [];

	await page.routeWebSocket(
		(url) => url.port === '4991',
		async (socket) => {
			attemptCount += 1;
			let closed = false;
			let server: WebSocketRoute | undefined;
			let pair: { socket: WebSocketRoute; server: WebSocketRoute } | undefined;
			socket.onClose(async (code, reason) => {
				if (closed) return;
				closed = true;
				if (pair) pairs.delete(pair);
				await server?.close({ code, reason });
				// Acknowledge page closes so routed sockets cannot remain CLOSING.
				await socket.close({ code, reason });
			});
			if (cut) await new Promise<void>((resolve) => waiting.push(resolve));
			if (closed) return;
			server = socket.connectToServer();
			connectedCount += 1;
			pair = { socket, server };
			pairs.add(pair);
			server.onClose(async (code, reason) => {
				serverCloses.push({ code, reason });
				if (pair) pairs.delete(pair);
				if (closed) return;
				closed = true;
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
		// Historical unreleased handlers, including retired attempts awaiting open to close.
		heldCount: () => waiting.length,
		attemptCount: () => attemptCount,
		serverCloses: () => [...serverCloses],
		connectedCount: () => connectedCount,
		openCount: () => pairs.size,
		restoreNewest: () => waiting.pop()?.(),
		restore: () => {
			cut = false;
			for (const resolve of waiting.splice(0)) resolve();
		},
	};
};

export { installServerUnreachableFault };
