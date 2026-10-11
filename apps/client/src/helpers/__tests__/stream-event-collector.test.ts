import { describe, expect, it } from 'bun:test';
import type { TStreamEventBatch } from '@sharkord/shared';
import { createStreamEventCollector } from '../stream-event-collector';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const flushPromises = async () => {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
};
const fixture = (upload?: (batch: TStreamEventBatch, signal: AbortSignal) => Promise<void>) => {
	const jobs = new Map<ReturnType<typeof setTimeout>, () => void>();
	const uploads: TStreamEventBatch[] = [];
	let time = 100;
	let id = SESSION_A;
	const options = {
		clientVersion: '2.4.0',
		createId: () => id,
		now: () => time,
		upload:
			upload ??
			(async (batch: TStreamEventBatch) => {
				uploads.push(batch);
			}),
		schedule: (callback: () => void, _delay: number) => {
			const timer = setTimeout(() => {}, 60_000);
			timer.unref();
			jobs.set(timer, callback);
			return timer;
		},
		cancel: (timer: ReturnType<typeof setTimeout>) => {
			clearTimeout(timer);
			jobs.delete(timer);
		},
	};
	const collector = createStreamEventCollector(options);
	const runNext = () => {
		const entry = jobs.entries().next().value;
		if (!entry) throw new Error('No queued flush');
		const [timer, callback] = entry;
		options.cancel(timer);
		callback();
	};
	return {
		collector,
		uploads,
		jobs,
		runNext,
		setTime: (next: number) => {
			time = next;
		},
		setId: () => {
			id = SESSION_B;
		},
	};
};

describe('bounded stream event collector', () => {
	it('retains losses incurred during an upload and preserves its dispatched events', async () => {
		let complete: (() => void) | undefined;
		const accepted: TStreamEventBatch[] = [];
		const f = fixture(async (batch) => {
			accepted.push(batch);
			if (accepted.length === 1)
				await new Promise<void>((resolve) => {
					complete = resolve;
				});
		});
		f.collector.configure('server:user', true);
		for (let index = 0; index < 300; index += 1) f.collector.record({ event: 'watch_requested' });
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		for (let index = 0; index < 100; index += 1) f.collector.record({ event: 'watch_requested' });
		complete?.();
		await flushPromises();
		f.runNext();
		await flushPromises();
		expect(accepted[0]?.droppedEvents).toBe(44);
		expect(accepted[1]?.droppedEvents).toBe(100);
		expect(accepted[1]?.events[0]?.sequence).toBe(177);
		f.collector.dispose();
	});
	it('times out hanging uploads and abandons their batch without stranding later events', async () => {
		let calls = 0;
		const accepted: TStreamEventBatch[] = [];
		const f = fixture(async (batch) => {
			if (++calls <= 3) await new Promise<void>(() => {});
			else accepted.push(batch);
		});
		f.collector.configure('server:user', true);
		f.collector.authenticate();
		f.collector.record({ event: 'watch_requested' });
		for (let attempt = 0; attempt < 3; attempt += 1) {
			f.runNext();
			await flushPromises();
			f.runNext();
			await flushPromises();
		}
		expect(f.jobs.size).toBe(0);
		f.collector.record({ event: 'watch_stopped' });
		f.runNext();
		await flushPromises();
		expect(accepted[0]?.events.map((event) => event.sequence)).toEqual([2]);
		expect(accepted[0]?.droppedEvents).toBe(1);
		f.collector.dispose();
	});
	it('correlates recovery without carrying attempts across identity changes', async () => {
		const f = fixture();
		f.collector.configure('server:user', true);
		f.collector.setReconnectAttemptId(SESSION_A);
		f.collector.record({ event: 'consume_started' });
		f.collector.pause();
		f.collector.record({ event: 'consume_cancelled' });
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads[0]?.events.map((event) => event.reconnectAttemptId)).toEqual([SESSION_A, SESSION_A]);
		f.collector.configure('other:user', true);
		f.collector.record({ event: 'consume_started' });
		f.collector.setReconnectAttemptId('untrusted arbitrary context');
		f.collector.record({ event: 'consume_cancelled' });
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads[1]?.events.every((event) => event.reconnectAttemptId === undefined)).toBe(true);
		f.collector.dispose();
	});
	it('buffers disconnected events and flushes only after confirmed authentication', async () => {
		const f = fixture();
		f.collector.configure('server:user', true);
		f.collector.record({ event: 'watch_requested' });
		expect(f.jobs.size).toBe(0);
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads[0]?.events[0]).toEqual({ event: 'watch_requested', occurredAt: 100, sequence: 1 });
		f.collector.pause();
		f.setTime(200);
		f.collector.record({ event: 'producer_closed_received' });
		expect(f.jobs.size).toBe(0);
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads[1]?.events[0]?.sequence).toBe(2);
		expect(f.uploads[1]?.clientSessionId).toBe(SESSION_A);
		f.collector.dispose();
	});
	it('does not upload to unsupported old backends and clears queues across identities', async () => {
		const f = fixture();
		f.collector.configure('server:user', false);
		f.collector.authenticate();
		f.collector.record({ event: 'watch_requested' });
		expect(f.jobs.size).toBe(0);
		f.collector.configure('server:user', true);
		f.collector.record({ event: 'watch_stopped' });
		f.setId();
		f.collector.configure('other-server:user', true);
		f.collector.record({ event: 'watch_requested' });
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads[0]?.events.map((event) => event.event)).toEqual(['watch_requested']);
		expect(f.uploads[0]?.clientSessionId).toBe(SESSION_B);
		f.collector.dispose();
	});
	it('caps memory, batches at 32 and expires old disconnected events', async () => {
		const f = fixture();
		f.collector.configure('server:user', true);
		for (let index = 0; index < 300; index += 1) f.collector.record({ event: 'watch_requested' });
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads[0]?.events.length).toBe(32);
		expect(f.uploads[0]?.events[0]?.sequence).toBe(45);
		expect(f.uploads[0]?.droppedEvents).toBe(44);
		f.collector.pause();
		f.setTime(700_000);
		f.collector.authenticate();
		f.runNext();
		await flushPromises();
		expect(f.uploads.length).toBe(1);
		f.collector.dispose();
	});
	it('abandons a failed batch after three tries and keeps newer events', async () => {
		let failures = 0;
		const accepted: TStreamEventBatch[] = [];
		const f = fixture(async (batch) => {
			if (failures++ < 3) throw new Error('offline');
			accepted.push(batch);
		});
		f.collector.configure('server:user', true);
		f.collector.authenticate();
		for (let index = 0; index < 33; index += 1) f.collector.record({ event: 'watch_requested' });
		for (let attempt = 0; attempt < 4; attempt += 1) {
			f.runNext();
			await flushPromises();
		}
		expect(accepted[0]?.events.map((event) => event.sequence)).toEqual([33]);
		expect(accepted[0]?.droppedEvents).toBe(32);
		expect(f.jobs.size).toBe(0);
		f.collector.dispose();
	});
	it('does not dispatch a deferred upload after disconnect or identity reset', async () => {
		const f = fixture();
		f.collector.configure('server:user', true);
		f.collector.authenticate();
		f.collector.record({ event: 'watch_requested' });
		f.runNext();
		f.collector.pause();
		await flushPromises();
		expect(f.uploads.length).toBe(0);
		f.collector.authenticate();
		f.runNext();
		f.setId();
		f.collector.configure('new:user', true);
		await flushPromises();
		expect(f.uploads.length).toBe(0);
		f.collector.dispose();
	});
	it('ignores old late completions and binds replacement uploaders', async () => {
		let resolveOld: (() => void) | undefined;
		const sent: TStreamEventBatch[] = [];
		const f = fixture(
			async () =>
				new Promise<void>((resolve) => {
					resolveOld = resolve;
				}),
		);
		f.collector.configure('server:user', true);
		f.collector.authenticate();
		f.collector.record({ event: 'watch_stopped' });
		f.runNext();
		await flushPromises();
		f.setId();
		f.collector.configure('new:user', true, async (batch) => {
			sent.push(batch);
		});
		f.collector.record({ event: 'watch_requested' });
		f.collector.authenticate();
		resolveOld?.();
		await flushPromises();
		f.runNext();
		await flushPromises();
		expect(sent[0]?.clientSessionId).toBe(SESSION_B);
		expect(sent[0]?.events.map((event) => event.event)).toEqual(['watch_requested']);
		f.collector.dispose();
	});
});
