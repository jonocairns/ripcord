import type { Page, WebSocketRoute } from '@playwright/test';

const restoreIds = (message: string | Buffer): string[] => {
	if (typeof message !== 'string') return [];
	let payload: unknown;
	try {
		payload = JSON.parse(message);
	} catch {
		return [];
	}
	const ids: string[] = [];
	for (const request of Array.isArray(payload) ? payload : [payload]) {
		if (typeof request !== 'object' || request === null) continue;
		const params: unknown = Reflect.get(request, 'params');
		if (typeof params !== 'object' || params === null || Reflect.get(params, 'path') !== 'voice.restoreOrJoin') {
			continue;
		}
		const input: unknown = Reflect.get(params, 'input');
		if (typeof input !== 'object' || input === null) continue;
		const id: unknown = Reflect.get(input, 'reconnectAttemptId');
		if (typeof id === 'string') ids.push(id);
	}
	return ids;
};

// Close the real server connection without delivering its close notification,
// like a half-open network connection. The production heartbeat detects loss.
// Hold replacement signaling until released, then forward it to the real server.
const installAppWebSocketOutage = async (page: Page) => {
	let blocked = false;
	const servers = new Set<WebSocketRoute>();
	const heldConnections = new Set<() => void>();
	const restoreAttemptIds: string[] = [];
	await page.routeWebSocket(
		(url) => url.port === '4991',
		(socket) => {
			let server: WebSocketRoute | undefined;
			let closed = false;
			const pendingMessages: (string | Buffer)[] = [];
			const forward = (target: WebSocketRoute, message: string | Buffer) => {
				restoreAttemptIds.push(...restoreIds(message));
				target.send(message);
			};
			const connect = () => {
				heldConnections.delete(connect);
				const connectedServer = socket.connectToServer();
				server = connectedServer;
				servers.add(connectedServer);
				connectedServer.onClose(async (code, reason) => {
					servers.delete(connectedServer);
					if (!blocked) await socket.close({ code, reason });
				});
				for (const message of pendingMessages.splice(0)) forward(connectedServer, message);
			};
			socket.onMessage((message) => {
				if (server) {
					if (!blocked) forward(server, message);
				} else {
					pendingMessages.push(message);
				}
			});
			socket.onClose(async (code, reason) => {
				if (closed) return;
				closed = true;
				heldConnections.delete(connect);
				pendingMessages.length = 0;
				if (server) {
					servers.delete(server);
					await server.close({ code, reason });
				}
				// Acknowledge client-initiated closes even when the server side is
				// already closed; otherwise the routed socket stays in CLOSING.
				await socket.close({ code, reason });
			});
			if (blocked) heldConnections.add(connect);
			else connect();
		},
	);
	return {
		disconnect: async () => {
			blocked = true;
			await Promise.all(
				[...servers].map((server) => server.close({ code: 4013, reason: 'Playwright signaling outage' })),
			);
		},
		resume: () => {
			blocked = false;
			for (const connect of [...heldConnections]) connect();
		},
		getRestoreAttemptIds: () => [...restoreAttemptIds],
	};
};

export { installAppWebSocketOutage };
