import type { ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

// Loopback-only fault proxy for the native lifecycle tests. Media still uses the
// isolated backend; only selected HTTP/RPC replies are delayed or rejected.
export function installFailureFixture(server: ViteDevServer) {
	let hold = new Set<string>();
	let fail = new Set<string>();
	let twoFactor = false;
	let expired = false;
	let listenOnly = false;
	let authenticated: unknown;
	let refreshedToken: string | undefined;
	let revokedReplacement = false;
	let paths: string[] = [];
	const held: (() => void)[] = [];
	const clients = new Map<WebSocket, { subscription?: number; producer?: string; consumer?: string }>();
	const deliver = (path: string, send: () => void) => {
		if (hold.has(path)) held.push(send);
		else send();
	};
	server.middlewares.use('/failure', async (req, res) => {
		res.setHeader('Content-Type', 'application/json');
		try {
			const path = new URL(req.url || '/', 'http://localhost').pathname.slice(1);
			if (path === 'control') {
				let body = '';
				for await (const chunk of req) body += chunk;
				const control = body ? JSON.parse(body) : {};
				if (control.reset) {
					hold.clear();
					fail.clear();
					twoFactor = false;
					expired = false;
					listenOnly = false;
					authenticated = undefined;
					refreshedToken = undefined;
					revokedReplacement = false;
					paths = [];
				}
				if (control.hold) hold = new Set(control.hold);
				if (control.fail) fail = new Set(control.fail);
				if (control.twoFactor !== undefined) twoFactor = control.twoFactor;
				if (control.expired !== undefined) expired = control.expired;
				if (control.listenOnly !== undefined) listenOnly = control.listenOnly;
				if (control.reset || control.release) {
					for (const send of held.splice(0)) send();
				}
				if (control.event) {
					for (const [client, state] of clients) {
						if (state.subscription === undefined) continue;
						client.send(
							JSON.stringify({
								id: state.subscription,
								result: {
									type: 'data',
									data: {
										userId: 1,
										...(control.event === 'legacy'
											? {}
											: {
													source: control.event === 'producer' ? 'producer-dtls' : 'consumer-dtls',
													transportId:
														control.event === 'stale'
															? 'old-transport'
															: control.event === 'producer'
																? state.producer
																: state.consumer,
												}),
									},
								},
							}),
						);
					}
				}
				res.end(JSON.stringify({ paths, held: held.length, revokedReplacement }));
				return;
			}
			paths.push(path);
			let body = '';
			for await (const chunk of req) body += chunk;
			if (path === 'verify-2fa' && twoFactor) {
				res.statusCode = expired ? 401 : 200;
				res.end(JSON.stringify(expired ? { error: 'Challenge expired' } : authenticated));
				return;
			}
			const response = await fetch(`http://127.0.0.1:4993/${path}`, {
				method: req.method,
				headers: { 'Content-Type': 'application/json' },
				body: body || undefined,
			});
			let text = await response.text();
			if (path === 'refresh' && response.ok) refreshedToken = JSON.parse(text).refreshToken;
			if (path === 'logout' && refreshedToken && response.ok) {
				revokedReplacement = JSON.parse(body).refreshToken === refreshedToken;
			}
			if (path === 'login' && twoFactor && response.ok) {
				authenticated = JSON.parse(text);
				text = JSON.stringify({ requires2fa: true, challengeToken: 'fixture-challenge' });
			}
			deliver(path, () => {
				res.statusCode = response.status;
				res.end(text);
			});
		} catch (error) {
			res.statusCode = 500;
			res.end(JSON.stringify({ error: String(error) }));
		}
	});
	const sockets = new WebSocketServer({ noServer: true });
	server.httpServer?.on('upgrade', (req, socket, head) => {
		if (!req.url?.startsWith('/failure?')) return;
		sockets.handleUpgrade(req, socket, head, (client) => {
			const upstream = new WebSocket('ws://127.0.0.1:4993/?connectionParams=1');
			const requests = new Map<number, string>();
			const queued: string[] = [];
			const state: { subscription?: number; producer?: string; consumer?: string } = {};
			clients.set(client, state);
			upstream.on('open', () => {
				for (const text of queued) upstream.send(text);
			});
			client.on('message', (data) => {
				const text = data.toString();
				if (text !== 'PONG') {
					const frame = JSON.parse(text);
					const path = frame.params?.path;
					if (path) {
						paths.push(path);
						requests.set(frame.id, path);
						if (path === 'voice.onTransportFailed') state.subscription = frame.id;
						if (fail.has(path) || fail.has(`${path}:${frame.params.input?.kind}`)) {
							client.send(JSON.stringify({ id: frame.id, error: { message: `Fixture rejected ${path}` } }));
							return;
						}
					}
				}
				if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
				else queued.push(text);
			});
			upstream.on('message', (data) => {
				let text = data.toString();
				const frame = text === 'PING' ? {} : JSON.parse(text);
				const path = requests.get(frame.id) || '';
				if (path === 'voice.join' && frame.result?.data) {
					state.producer = frame.result.data.producerTransportParams.id;
					state.consumer = frame.result.data.consumerTransportParams.id;
				}
				if (listenOnly && path === 'others.joinServer' && frame.result?.data) {
					const permissions = frame.result.data.channelPermissions;
					for (const channel of frame.result.data.channels) {
						if (channel.type !== 'VOICE') continue;
						channel.private = true;
						permissions[channel.id].permissions.VIEW_CHANNEL = true;
						permissions[channel.id].permissions.JOIN = true;
						permissions[channel.id].permissions.SPEAK = false;
					}
					text = JSON.stringify(frame);
				}
				deliver(path, () => {
					if (client.readyState === WebSocket.OPEN) client.send(text);
				});
			});
			client.on('close', () => {
				clients.delete(client);
				upstream.close();
			});
			upstream.on('close', () => client.close());
			upstream.on('error', () => client.close());
		});
	});
}
