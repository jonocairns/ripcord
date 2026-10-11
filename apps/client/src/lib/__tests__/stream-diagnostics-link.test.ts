import { describe, expect, it } from 'bun:test';
import type { AppRouter, TStreamEventBatch } from '@sharkord/shared';
import { createTRPCProxyClient, createWSClient, type TRPCLink, wsLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createStreamEventCollector } from '@/helpers/stream-event-collector';
import { streamDiagnosticsLink } from '../stream-diagnostics-link';

const SESSION = '11111111-1111-4111-8111-111111111111';
const settle = async () => {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('stream diagnostics WebSocket cancellation', () => {
	it('skips aborted dispatches and releases a request aborted while subscribing', async () => {
		for (const abortedBeforeDispatch of [true, false]) {
			const controller = new AbortController();
			let subscriptions = 0;
			let releases = 0;
			const abortDuringSubscription: TRPCLink<AppRouter> = () => () =>
				observable(() => {
					subscriptions += 1;
					controller.abort();
					return () => {
						releases += 1;
					};
				});
			const client = createTRPCProxyClient<AppRouter>({ links: [streamDiagnosticsLink, abortDuringSubscription] });
			if (abortedBeforeDispatch) controller.abort();
			const batch: TStreamEventBatch = {
				clientSessionId: SESSION,
				clientVersion: 'test',
				droppedEvents: 0,
				events: [{ event: 'watch_requested', occurredAt: 100, sequence: 1 }],
			};
			await expect(client.voice.reportStreamEvents.mutate(batch, { signal: controller.signal })).rejects.toThrow(
				'cancelled',
			);
			expect(subscriptions).toBe(abortedBeforeDispatch ? 0 : 1);
			expect(releases).toBe(abortedBeforeDispatch ? 0 : 1);
		}
	});
	it('releases hung tRPC requests on timeout retries and identity changes', async () => {
		let received = 0;
		const server = Bun.serve({
			port: 0,
			fetch: (request, server) => {
				if (server.upgrade(request)) return;
				return new Response('WebSocket required', { status: 400 });
			},
			websocket: {
				// The socket stays open but never acknowledges diagnostics uploads.
				message: () => {
					received += 1;
				},
			},
		});
		const ws = createWSClient({ url: `ws://127.0.0.1:${server.port}`, lazy: { enabled: true, closeMs: 60_000 } });
		const client = createTRPCProxyClient<AppRouter>({ links: [streamDiagnosticsLink, wsLink({ client: ws })] });
		// Test-only inspection verifies real wsLink request/payload ownership.
		const manager = Reflect.get(ws, 'requestManager') as { getPendingRequests: () => unknown[] };
		const jobs = new Map<ReturnType<typeof setTimeout>, () => void>();
		const upload = (batch: TStreamEventBatch, signal: AbortSignal) =>
			client.voice.reportStreamEvents.mutate(batch, { signal });
		const collector = createStreamEventCollector({
			clientVersion: 'test',
			createId: () => SESSION,
			upload,
			schedule: (callback) => {
				const timer = setTimeout(() => {}, 60_000);
				timer.unref();
				jobs.set(timer, callback);
				return timer;
			},
			cancel: (timer) => {
				clearTimeout(timer);
				jobs.delete(timer);
			},
		});
		const runNext = () => {
			const job = jobs.entries().next().value;
			if (!job) throw new Error('Missing scheduled diagnostics job');
			const [timer, callback] = job;
			clearTimeout(timer);
			jobs.delete(timer);
			callback();
		};
		const waitForDispatch = async (count: number) => {
			const deadline = Date.now() + 2_000;
			while (received < count && Date.now() < deadline) await Bun.sleep(5);
			expect(received).toBe(count);
			expect(manager.getPendingRequests()).toHaveLength(1);
		};
		try {
			collector.configure('server:user', true);
			collector.authenticate();
			collector.record({ event: 'watch_requested' });
			for (let attempt = 1; attempt <= 3; attempt += 1) {
				runNext();
				await waitForDispatch(attempt);
				runNext(); // Upload timeout must release the actual wsLink request.
				await settle();
				expect(manager.getPendingRequests()).toHaveLength(0);
			}
			expect(jobs.size).toBe(0);
			collector.record({ event: 'watch_stopped' });
			runNext();
			await waitForDispatch(4);
			collector.configure('other:user', true);
			await settle();
			expect(manager.getPendingRequests()).toHaveLength(0);
		} finally {
			collector.dispose();
			ws.close();
			server.stop(true);
		}
	});
});
