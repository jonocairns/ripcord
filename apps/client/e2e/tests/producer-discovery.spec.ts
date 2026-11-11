import { type Browser, expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import {
	createPeer,
	credentialsFor,
	disposePeer,
	expectInboundVideoFlow,
	expectOutboundVideoFlow,
	installPcHook,
	joinVoice,
	leaveVoice,
	login,
	remoteCameraIndicator,
	startCamera,
	suppressViteHmrReload,
	watchRemoteCamera,
} from '../helpers/app';
import { expectMicrophoneFlow } from '../helpers/microphone';

type Id = string | number;
type Entry = {
	seq: number;
	at: number;
	socket: number;
	kind: string;
	id?: Id;
	path?: string;
	name?: string;
	videoIds?: unknown;
	forwarded?: boolean;
};
type SocketRecord = {
	socket: WebSocketRoute;
	server: WebSocketRoute;
	held: Map<Id, { request: object; path: string }>;
	producerSubscriptionIds: Map<Id, string>;
	snapshotIds: Set<Id>;
	produceIds: Set<Id>;
};
const object = (value: unknown): value is object => typeof value === 'object' && value !== null;
const items = (message: string): unknown[] => {
	const payload: unknown = JSON.parse(message);
	return Array.isArray(payload) ? payload : [payload];
};

const recordProducerDiscovery = async (page: Page) => {
	const sockets: SocketRecord[] = [];
	const timeline: Entry[] = [];
	let hold = false;
	let swallowStarted = false;
	const add = (socket: number, kind: string, details: Partial<Entry> = {}) => {
		const entry: Entry = { ...details, seq: timeline.length + 1, at: Date.now(), socket, kind };
		timeline.push(entry);
		return entry;
	};
	const mark = (name: string) => add(sockets.length - 1, 'mark', { name });
	page.on('console', (message) => {
		const text = message.text();
		if (text.includes('Syncing existing producers after voice event subscription start'))
			add(sockets.length - 1, 'acknowledged-log');
		if (text.includes('Syncing existing producers without a subscription acknowledgement'))
			add(sockets.length - 1, 'fallback-log');
	});
	await page.routeWebSocket(
		(url) => url.port === '4991',
		(socket) => {
			const server = socket.connectToServer();
			const index = sockets.length;
			const record: SocketRecord = {
				socket,
				server,
				held: new Map(),
				producerSubscriptionIds: new Map(),
				snapshotIds: new Set(),
				produceIds: new Set(),
			};
			sockets.push(record);
			socket.onMessage((message) => {
				if (typeof message !== 'string' || message === 'PING' || message === 'PONG') {
					server.send(message);
					return;
				}
				for (const request of items(message)) {
					if (!object(request)) {
						server.send(JSON.stringify(request));
						continue;
					}
					const id: unknown = Reflect.get(request, 'id');
					const method: unknown = Reflect.get(request, 'method');
					const params: unknown = Reflect.get(request, 'params');
					const path: unknown = object(params) ? Reflect.get(params, 'path') : undefined;
					if (typeof id === 'string' || typeof id === 'number') {
						if (method === 'subscription' && (path === 'voice.onNewProducer' || path === 'voice.onProducerClosed')) {
							record.producerSubscriptionIds.set(id, path);
							add(index, 'subscribed', { id, path });
							if (hold) {
								record.held.set(id, { request, path });
								add(index, 'held', { id, path });
								continue;
							}
						}
						if (method === 'subscription.stop' && record.held.delete(id)) {
							add(index, 'stop-dropped', { id });
							continue;
						}
						if (path === 'voice.getProducers') {
							record.snapshotIds.add(id);
							add(index, 'snapshot-request', { id, path });
						}
						if (path === 'voice.produce') record.produceIds.add(id);
					}
					server.send(JSON.stringify(request));
				}
			});
			server.onMessage((message) => {
				if (typeof message !== 'string' || message === 'PING' || message === 'PONG') {
					socket.send(message);
					return;
				}
				for (const response of items(message)) {
					if (object(response)) {
						const id: unknown = Reflect.get(response, 'id');
						const result: unknown = Reflect.get(response, 'result');
						if ((typeof id === 'string' || typeof id === 'number') && object(result)) {
							const type: unknown = Reflect.get(result, 'type');
							if (type === 'started' && record.producerSubscriptionIds.has(id)) {
								add(index, 'started', { id, path: record.producerSubscriptionIds.get(id), forwarded: !swallowStarted });
								if (swallowStarted) continue;
							}
							if (record.snapshotIds.has(id) && type === 'data') {
								const data: unknown = Reflect.get(result, 'data');
								add(index, 'snapshot-response', {
									id,
									videoIds: object(data) ? Reflect.get(data, 'remoteVideoIds') : undefined,
								});
							}
							if (record.produceIds.has(id)) add(index, 'produce-response', { id });
						}
					}
					socket.send(JSON.stringify(response));
				}
			});
		},
	);
	const latest = () => {
		const record = sockets.at(-1);
		if (!record) throw new Error('No app socket');
		return record;
	};
	const releaseOne = (path: string) => {
		const record = latest();
		for (const [id, held] of record.held) {
			if (held.path !== path) continue;
			record.held.delete(id);
			add(sockets.length - 1, 'released', { id, path });
			record.server.send(JSON.stringify(held.request));
			return id;
		}
		throw new Error(`No held subscription for ${path}`);
	};
	const release = () => {
		hold = false;
		const barrier = mark('release');
		const released = [...latest().held.values()].map(({ path }) => releaseOne(path));
		return { barrier, released };
	};
	const after = (entry: Entry, kind: string) => timeline.filter((item) => item.seq > entry.seq && item.kind === kind);
	const settled = async (barrier: Entry) => {
		await expect
			.poll(
				() => {
					const held = latest().held;
					return (
						after(barrier, 'produce-response').length > 0 &&
						held.size === 2 &&
						new Set([...held.values()].map(({ path }) => path)).size === 2 &&
						timeline
							.filter((entry) => entry.kind === 'snapshot-request')
							.every((request) =>
								timeline.some(
									(response) =>
										response.kind === 'snapshot-response' &&
										response.socket === request.socket &&
										response.id === request.id,
								),
							)
					);
				},
				{
					timeout: 20_000,
					message: 'barrier A: microphone published, snapshots answered, final two subscriptions held',
				},
			)
			.toBe(true);
		mark('barrier-A');
	};
	const started = async (ids: Id[], barrier: Entry) => {
		await expect
			.poll(() => ids.every((id) => after(barrier, 'started').some((entry) => entry.id === id)), { timeout: 10_000 })
			.toBe(true);
		return mark('barrier-B');
	};
	return {
		sockets,
		timeline,
		mark,
		after,
		latest,
		release,
		releaseOne,
		settled,
		started,
		setHold: () => {
			hold = true;
		},
		setSwallowStarted: () => {
			swallowStarted = true;
		},
	};
};
const watcherPage = async (browser: Browser) => {
	const context = await browser.newContext();
	await installPcHook(context);
	const page = await context.newPage();
	await suppressViteHmrReload(page);
	const recorder = await recordProducerDiscovery(page);
	return { context, page, recorder };
};

for (const rejoin of [true, false]) {
	test(`a producer announced before the subscriptions attach is discovered (rejoin: ${rejoin})`, async ({
		browser,
	}, testInfo) => {
		test.setTimeout(90_000);
		const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
		const { context, page, recorder: r } = await watcherPage(browser);
		const watcher = { context, page, credentials: credentialsFor(testInfo, 'watcher') };
		try {
			await joinVoice(producer.page);
			await expectMicrophoneFlow(producer.page, 'outbound');
			await login(page, watcher.credentials);
			if (rejoin) {
				await joinVoice(page);
				await expectMicrophoneFlow(page, 'inbound');
				await leaveVoice(page);
			}
			r.setHold();
			const hold = r.mark('hold-on');
			const socketCount = r.sockets.length;
			await joinVoice(page);
			await r.settled(hold);
			r.mark('camera-start');
			await startCamera(producer.page);
			await expectOutboundVideoFlow(producer.page, 'camera to send while watcher subscriptions are held');
			r.mark('camera-live');
			const { barrier, released } = r.release();
			await r.started(released, barrier);
			// Keep this UI assertion first: the unchanged spec must fail here on main,
			// rather than failing early because main has no gate/logging implementation.
			await watchRemoteCamera(page);
			await expectInboundVideoFlow(page, 'camera announced before the subscriptions attached', 20_000);
			await expect.poll(() => r.after(barrier, 'acknowledged-log').length, { timeout: 5_000 }).toBe(1);
			const lastHeld = r.after(hold, 'held').at(-1);
			expect(lastHeld).toBeDefined();
			expect(
				barrier.at - (lastHeld?.at ?? 0),
				'the acknowledgements were held longer than the fallback allows; the ordering proof is void, run again',
			).toBeLessThan(15_000);
			expect(r.after(hold, 'snapshot-request').filter((entry) => entry.seq < barrier.seq)).toEqual([]);
			const starts = r.after(barrier, 'started').filter((entry) => released.includes(entry.id ?? ''));
			expect(starts).toHaveLength(2);
			const acknowledged = r.after(barrier, 'acknowledged-log')[0];
			if (!acknowledged) throw new Error('Missing acknowledged sync for the held effect run');
			expect(acknowledged.socket).toBe(barrier.socket);
			expect(acknowledged.seq).toBeGreaterThan(Math.max(...starts.map((entry) => entry.seq)));
			const requests = r.after(hold, 'snapshot-request');
			expect(requests).toHaveLength(1);
			const request = requests[0];
			if (!request) throw new Error('Missing ordered snapshot');
			expect(request.seq).toBeGreaterThan(Math.max(...starts.map((entry) => entry.seq)));
			await expect
				.poll(() =>
					r.timeline.some(
						(entry) =>
							entry.kind === 'snapshot-response' &&
							entry.socket === request.socket &&
							entry.id === request.id &&
							Array.isArray(entry.videoIds) &&
							entry.videoIds.length > 0,
					),
				)
				.toBe(true);
			r.mark('final-assertion');
			// Tie the acknowledged sync to the held effect run: no later run may have subscribed.
			expect(r.after(barrier, 'subscribed')).toEqual([]);
			expect(r.after(barrier, 'acknowledged-log')).toHaveLength(1);
			expect(r.after(hold, 'snapshot-request')).toHaveLength(1);
			expect(r.after(hold, 'fallback-log')).toEqual([]);
			expect(r.sockets).toHaveLength(socketCount);
		} finally {
			await testInfo.attach('producer-discovery-timeline', {
				body: JSON.stringify(r.timeline, null, 2),
				contentType: 'application/json',
			});
			await disposePeer(watcher);
			await disposePeer(producer);
		}
	});
}

test('an ended producer subscription still repairs, and cannot release a snapshot', async ({ browser }, testInfo) => {
	test.setTimeout(90_000);
	const producer = await createPeer(browser, credentialsFor(testInfo, 'producer'));
	const { context, page, recorder: r } = await watcherPage(browser);
	const watcher = { context, page, credentials: credentialsFor(testInfo, 'watcher') };
	try {
		await joinVoice(producer.page);
		await expectMicrophoneFlow(producer.page, 'outbound');
		await login(page, watcher.credentials);
		// Join and leave once first, as the rejoin cases do, so the held join is not the
		// first join after login (which runs the subscription effect one extra time).
		await joinVoice(page);
		await expectMicrophoneFlow(page, 'inbound');
		await leaveVoice(page);
		r.setHold();
		const hold = r.mark('hold-on');
		await joinVoice(page);
		await r.settled(hold);
		const newId = r.releaseOne('voice.onNewProducer');
		await r.started([newId], hold);
		const error = r.mark('error-injected');
		r.latest().socket.send(
			JSON.stringify({
				id: newId,
				error: {
					message: 'Injected subscription error',
					code: -32603,
					data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
				},
			}),
		);
		await expect
			.poll(
				() =>
					r
						.after(error, 'snapshot-request')
						.some((request) =>
							r
								.after(error, 'snapshot-response')
								.some((response) => response.id === request.id && response.socket === request.socket),
						),
				{ timeout: 10_000 },
			)
			.toBe(true);
		const closedId = r.releaseOne('voice.onProducerClosed');
		await r.started([closedId], error);
		await startCamera(producer.page);
		await expectOutboundVideoFlow(producer.page, 'camera after subscription error');
		await expect(remoteCameraIndicator(page).first()).toBeVisible({ timeout: 20_000 });
		expect(r.after(error, 'snapshot-request')).toHaveLength(1);
	} finally {
		await testInfo.attach('producer-discovery-timeline', {
			body: JSON.stringify(r.timeline, null, 2),
			contentType: 'application/json',
		});
		await disposePeer(watcher);
		await disposePeer(producer);
	}
});

test('a server that never acknowledges still gets the snapshot', async ({ browser }, testInfo) => {
	test.setTimeout(60_000);
	const { context, page, recorder: r } = await watcherPage(browser);
	const watcher = { context, page, credentials: credentialsFor(testInfo, 'watcher') };
	try {
		await login(page, watcher.credentials);
		r.setSwallowStarted();
		const join = r.mark('join');
		await joinVoice(page);
		await expect.poll(() => r.after(join, 'snapshot-request').length, { timeout: 40_000 }).toBeGreaterThan(0);
		const request = r.after(join, 'snapshot-request')[0];
		if (!request) throw new Error('Missing fallback snapshot');
		const subscribed = r
			.after(join, 'subscribed')
			.filter((entry) => entry.seq < request.seq)
			.at(-1);
		if (!subscribed) throw new Error('Missing producer subscriptions');
		expect(request.at - subscribed.at).toBeGreaterThanOrEqual(15_000);
		expect(request.at - subscribed.at).toBeLessThanOrEqual(30_000);
		await expect
			.poll(() =>
				r.after(join, 'snapshot-response').some((entry) => entry.id === request.id && entry.socket === request.socket),
			)
			.toBe(true);
		await expect.poll(() => r.after(join, 'fallback-log').length).toBe(1);
		expect(r.after(join, 'snapshot-request')).toHaveLength(1);
		expect(r.after(join, 'started').filter((entry) => entry.forwarded)).toEqual([]);
		expect(r.after(join, 'acknowledged-log')).toEqual([]);
	} finally {
		await testInfo.attach('producer-discovery-timeline', {
			body: JSON.stringify(r.timeline, null, 2),
			contentType: 'application/json',
		});
		await disposePeer(watcher);
	}
});
